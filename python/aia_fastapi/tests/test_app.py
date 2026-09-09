"""What the shared HTTP glue promises every Python service.

These tests exist because the glue is now the ONLY copy. When three services
each had their own `_authenticate`, a mistake reached one service; here it
reaches all of them at once, including the two that do not exist yet.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Annotated, Any

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from aia_auth import InvalidTokenError, JwtVerifier, Principal, ProjectMembership
from aia_errors import ForbiddenError, NotFoundError
from aia_fastapi import (
    AuthenticatedCaller,
    PlatformSettings,
    authenticated,
    create_app,
    health_router,
    install_problem_details,
)

MEMBER = Principal(
    id="user-1",
    type="user",
    issuer="http://identity",
    expires_at=time.time() + 3600,
    memberships=(ProjectMembership(project_id="proj-1", roles=("project_viewer",)),),
)
OUTSIDER = Principal(
    id="user-2", type="user", issuer="http://identity", expires_at=time.time() + 3600
)
SERVICE = Principal(
    id="aia-knowledge", type="service", issuer="http://identity", expires_at=time.time() + 3600
)
ADMIN = Principal(
    id="root",
    type="user",
    issuer="http://identity",
    expires_at=time.time() + 3600,
    global_roles=("platform_admin",),
)


class FakeVerifier(JwtVerifier):
    """Answers from a table instead of a JWKS.

    A fake rather than a mock: it honours the real contract, including that an
    unknown token raises instead of returning None.
    """

    def __init__(self, principals: dict[str, Principal]) -> None:
        super().__init__(issuer="http://identity", jwks_uri="http://identity/jwks")
        self.principals = principals

    def verify(self, token: str) -> Principal:
        principal = self.principals.get(token)
        if principal is None:
            raise InvalidTokenError("unknown token")
        return principal


VERIFIER = FakeVerifier(
    {"member": MEMBER, "outsider": OUTSIDER, "service": SERVICE, "admin": ADMIN}
)


# Module level, not inside the factory below, and that is not a style choice.
# `from __future__ import annotations` makes every annotation a string, and
# FastAPI resolves those against the MODULE namespace: an alias declared inside
# a function is invisible there, and every guarded route answers 422 with no
# hint as to why. The three services declare theirs at module level for the
# same reason.
Caller = Annotated[AuthenticatedCaller, authenticated(lambda: VERIFIER)]


def guarded_app() -> FastAPI:
    app = FastAPI()
    install_problem_details(app)
    router = APIRouter()

    @router.get("/v1/whoami")
    def whoami(caller: Caller) -> dict[str, str]:
        return {
            "principal_id": caller.principal.id,
            "project_id": caller.project_id,
            "token": caller.token,
        }

    app.include_router(router)
    return app


def headers(token: str = "member", project: str | None = "proj-1") -> dict[str, str]:
    sent = {"Authorization": f"Bearer {token}"}
    if project is not None:
        sent["X-Project-Id"] = project
    return sent


# --- Problem Details -------------------------------------------------------


def failing_app(raise_: Callable[[], Any]) -> TestClient:
    app = FastAPI()
    install_problem_details(app)

    @app.get("/v1/boom")
    def boom() -> dict[str, str]:
        raise_()
        return {}

    # `raise_server_exceptions=False`, because Starlette re-raises after calling
    # the 500 handler -- that is how uvicorn gets to log it. Leaving the default
    # would test the re-raise instead of the response the client receives.
    return TestClient(app, raise_server_exceptions=False)


def test_a_domain_error_becomes_problem_details() -> None:
    client = failing_app(lambda: (_ for _ in ()).throw(NotFoundError("store", "st-9")))
    response = client.get("/v1/boom")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 404
    assert body["code"] == "not_found"
    assert body["instance"] == "/v1/boom"
    assert body["type"].startswith("https://")


def test_an_unknown_error_never_reaches_the_caller() -> None:
    """The internal message goes to the log only (CLAUDE.md, reference doc 02 §6).

    An unhandled exception carries whatever the failing library put in it, and
    that is regularly a connection string.
    """
    secret = "mongodb://admin:hunter2@mongo:27017"
    client = failing_app(lambda: (_ for _ in ()).throw(RuntimeError(secret)))
    response = client.get("/v1/boom")

    assert response.status_code == 500
    assert "hunter2" not in response.text
    assert "mongodb" not in response.text
    assert response.json()["code"] == "internal_error"


def test_the_problem_names_the_failing_path() -> None:
    client = failing_app(lambda: (_ for _ in ()).throw(ForbiddenError("nope")))
    assert client.get("/v1/boom").json()["instance"] == "/v1/boom"


# --- Health ----------------------------------------------------------------


def test_liveness_never_consults_a_dependency() -> None:
    """Restarting a pod because Mongo blinked turns degradation into an outage."""

    def ready() -> dict[str, str]:
        raise AssertionError("liveness must not ask the service whether it can serve")

    client = TestClient(FastAPI())
    client.app.include_router(health_router(ready=ready))  # type: ignore[attr-defined]

    assert client.get("/health/live").json() == {"status": "ok"}


def test_readiness_reports_what_the_service_decides() -> None:
    app = FastAPI()
    app.include_router(health_router(ready=lambda: {"status": "degraded", "detector": "regex"}))

    body = TestClient(app).get("/health/ready").json()
    assert body == {"status": "degraded", "detector": "regex"}


async def test_readiness_may_be_asynchronous() -> None:
    """A check that has to reach Mongo is async; one that reads a loaded model
    is not. Neither should have to pretend to be the other."""

    async def ready() -> dict[str, str]:
        return {"status": "ok", "mongo": "reachable"}

    app = FastAPI()
    app.include_router(health_router(ready=ready))

    assert TestClient(app).get("/health/ready").json() == {
        "status": "ok",
        "mongo": "reachable",
    }


def test_readiness_without_a_callback_is_ok() -> None:
    app = FastAPI()
    app.include_router(health_router())
    assert TestClient(app).get("/health/ready").json() == {"status": "ok"}


# --- Authentication and the coarse authorisation gate ----------------------


@pytest.mark.parametrize(
    ("sent", "status", "code"),
    [
        ({}, 401, "unauthenticated"),
        ({"Authorization": "Basic abc", "X-Project-Id": "proj-1"}, 401, "unauthenticated"),
        ({"Authorization": "Bearer ", "X-Project-Id": "proj-1"}, 401, "unauthenticated"),
        ({"Authorization": "Bearer forged", "X-Project-Id": "proj-1"}, 401, "invalid_token"),
    ],
)
def test_a_call_without_a_usable_token_is_refused(
    sent: dict[str, str], status: int, code: str
) -> None:
    response = TestClient(guarded_app()).get("/v1/whoami", headers=sent)
    assert response.status_code == status
    assert response.json()["code"] == code


def test_the_project_header_is_required() -> None:
    """`project_id` is required on every contract (reference doc 02, principle 2)."""
    response = TestClient(guarded_app()).get("/v1/whoami", headers=headers(project=None))
    assert response.status_code == 400
    assert response.json()["code"] == "project_required"


def test_a_principal_outside_the_project_is_refused() -> None:
    response = TestClient(guarded_app()).get("/v1/whoami", headers=headers("outsider"))
    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "forbidden"
    # RFC 9457 extension members: the rule that denied it, so an audit says WHY
    # and not merely "403", and the project it was denied on.
    assert "is a member of the project" in body["rule"]
    assert body["project_id"] == "proj-1"


def test_a_member_reaches_the_route() -> None:
    response = TestClient(guarded_app()).get("/v1/whoami", headers=headers())
    assert response.status_code == 200
    assert response.json()["principal_id"] == "user-1"
    assert response.json()["project_id"] == "proj-1"


def test_the_caller_carries_the_token_onwards() -> None:
    """ADR-017: a service acting for a person carries THEIR token to the next hop."""
    response = TestClient(guarded_app()).get("/v1/whoami", headers=headers())
    assert response.json()["token"] == "member"


def test_an_internal_service_reaches_a_project_it_does_not_belong_to() -> None:
    """The bypass is deliberate, and it is a named rule so a denial can explain it."""
    response = TestClient(guarded_app()).get("/v1/whoami", headers=headers("service"))
    assert response.status_code == 200


def test_a_platform_admin_reaches_any_project() -> None:
    assert TestClient(guarded_app()).get("/v1/whoami", headers=headers("admin")).status_code == 200


# --- create_app ------------------------------------------------------------


class Settings(PlatformSettings):
    pass


def test_create_app_mounts_the_routers_and_the_problem_filter() -> None:
    router = APIRouter()

    @router.get("/v1/boom")
    def boom() -> dict[str, str]:
        raise NotFoundError("store", "st-1")

    app = create_app(
        service_name="aia-test",
        title="Test",
        settings=Settings(),
        routers=(router, health_router()),
    )
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/health/live").status_code == 200
    assert client.get("/v1/boom").status_code == 404
    assert client.get("/v1/boom").headers["content-type"].startswith("application/problem+json")


def test_the_startup_hook_runs_before_the_first_request() -> None:
    warmed: list[str] = []

    async def warm_up() -> None:
        warmed.append("model")

    app = create_app(
        service_name="aia-test",
        title="Test",
        settings=Settings(),
        routers=(health_router(),),
        on_startup=warm_up,
    )

    assert warmed == []
    with TestClient(app) as client:
        assert warmed == ["model"]
        assert client.get("/health/live").status_code == 200


# --- Settings --------------------------------------------------------------


def test_the_jwks_url_derives_from_the_issuer_and_can_be_overridden() -> None:
    assert Settings().jwks_url == "http://identity:3001/.well-known/jwks.json"
    assert Settings(identity_jwks_url="http://other/jwks").jwks_url == "http://other/jwks"


def test_a_variable_meant_for_a_neighbour_does_not_stop_the_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Compose hands every container the same environment block."""
    monkeypatch.setenv("QDRANT_URL", "http://qdrant:6333")
    assert Settings().port == 8000

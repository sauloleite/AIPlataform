"""HTTP glue for the Python services. The counterpart to `@aia/nest`.

Three services wrote the same `main.py`, the same `Settings` base and the same
`_authenticate` block, differing only in a title, a port and which routers to
include. Two more Python services are coming, which would have made it five.

What is NOT here is as deliberate as what is. `ServiceTokenProvider` lives in
`aia_auth`, because fetching a token needs no web framework and one of the
services coming next consumes a queue and has no HTTP port at all — it must not
depend on FastAPI to authenticate.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic_settings import BaseSettings, SettingsConfigDict

from aia_auth import (
    POLICY,
    AccessRequest,
    JwtVerifier,
    Principal,
    authorize,
    bearer_token,
    is_internal_service,
)
from aia_errors import PROBLEM_CONTENT_TYPE, DomainError, ProjectRequiredError, problem_from_unknown
from aia_telemetry import AiaAttr, annotate_active_span, current_trace_id, start_telemetry

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class AuthenticatedCaller:
    """Who is calling, which project, and the token they came with.

    The token is returned rather than discarded because it travels: a service
    acting for a person carries THEIR token to the next service, so the registry
    and the gateway authorise the person and not the caller (ADR-017). Making
    each service re-read the header to get it back would be one more place to
    forget.
    """

    principal: Principal
    project_id: str
    token: str


class PlatformSettings(BaseSettings):
    """What every Python service reads from the environment (12-factor).

    A service subclasses this and adds its own. `extra="ignore"` because compose
    hands every container the same environment block, and a service refusing to
    start over a variable meant for its neighbour is a bad trade.
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    node_env: str = "development"
    port: int = 8000
    log_level: str = "info"

    identity_issuer: str = "http://identity:3001"
    identity_audience: str = "aia-platform"
    identity_jwks_url: str | None = None

    otel_exporter_otlp_endpoint: str | None = None

    @property
    def jwks_url(self) -> str:
        return self.identity_jwks_url or f"{self.identity_issuer}/.well-known/jwks.json"


def install_problem_details(app: FastAPI) -> None:
    """Turns every escaping exception into RFC 9457 Problem Details.

    Two handlers, because the two cases are not the same. A `DomainError` is
    something the platform decided and can explain. Anything else is a 500 whose
    message goes to the LOG only, correlated by trace id: a stack trace in a
    response is a gift to whoever is probing.
    """

    @app.exception_handler(DomainError)
    async def _domain_error(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, DomainError)
        return JSONResponse(
            status_code=error.status,
            content=error.to_problem(instance=request.url.path, trace_id=current_trace_id()),
            media_type=PROBLEM_CONTENT_TYPE,
        )

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, error: Exception) -> JSONResponse:
        logger.exception("request failed at %s", request.url.path)
        problem = problem_from_unknown(
            error, instance=request.url.path, trace_id=current_trace_id()
        )
        return JSONResponse(
            status_code=problem["status"], content=problem, media_type=PROBLEM_CONTENT_TYPE
        )


#: What a service reports on `/health/ready`. Sync or async, because a readiness
#: check that has to reach Mongo is async and one that reads a loaded model is
#: not, and neither should have to pretend to be the other.
ReadyCheck = Callable[[], dict[str, str] | Awaitable[dict[str, str]]]


def health_router(*, ready: ReadyCheck | None = None) -> APIRouter:
    """Liveness and readiness, with the difference that matters.

    Liveness answers from the process alone and NEVER queries a dependency:
    restarting a pod because Mongo blinked turns degradation into an outage.
    Readiness is where a service says whether it can serve, and `ready` is where
    it decides — the callback exists because only the service knows.
    """
    router = APIRouter(prefix="/health", tags=["health"])

    @router.get("/live")
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/ready")
    async def readiness() -> dict[str, str]:
        if ready is None:
            return {"status": "ok"}
        reported = ready()
        return await reported if isinstance(reported, Awaitable) else reported

    return router


def authenticated(verifier: Callable[[], JwtVerifier]) -> Any:
    """The dependency every authenticated route declares.

    A factory rather than a plain function, because the verifier comes from the
    service's own container and FastAPI resolves dependencies by identity. The
    caller writes `Authenticated = Annotated[tuple[Principal, str], Depends(...)]`
    once and uses it on every route.

    `Depends` appears only in presentation (reference doc 03 §3.3), which is why
    this lives in a library that services import from THAT layer and nowhere else.
    """

    def _authenticate(
        authorization: Annotated[str | None, Header()] = None,
        x_project_id: Annotated[str | None, Header()] = None,
    ) -> AuthenticatedCaller:
        token = bearer_token(authorization)
        principal = verifier().verify(token)
        if not x_project_id:
            raise ProjectRequiredError()

        # Named, rather than an unnamed `if principal.type != "service"`: a
        # denial then says WHICH rule refused and why, and that reaches the
        # Problem Details body and the audit with it. Recording the ALLOWING
        # branch is what `authorize`'s return value is for; no caller in either
        # language reads it yet, and putting it on the span is telemetry work.
        authorize(
            is_internal_service | POLICY.READ_PROJECT,
            AccessRequest(principal=principal, project_id=x_project_id),
        )

        annotate_active_span(
            **{
                AiaAttr.PROJECT_ID: x_project_id,
                AiaAttr.PRINCIPAL_ID: principal.id,
                AiaAttr.PRINCIPAL_TYPE: principal.type,
            }
        )
        return AuthenticatedCaller(principal=principal, project_id=x_project_id, token=token)

    return Depends(_authenticate)


def create_app(
    *,
    service_name: str,
    title: str,
    settings: PlatformSettings,
    routers: Iterable[APIRouter],
    description: str = "",
    version: str = "1.0.0",
    on_startup: Callable[[], Awaitable[None]] | None = None,
) -> FastAPI:
    """A FastAPI application with the platform's glue already on it.

    The boot sequence is shared because it has to be identical: a service that
    configured logging differently, or forgot `start_telemetry`, would be
    invisible in Grafana while looking perfectly healthy. `on_startup` is where
    a service does what only it knows — warming a model, opening a queue.
    """

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logging.basicConfig(level=settings.log_level.upper())
        start_telemetry(service_name)
        if on_startup is not None:
            await on_startup()
        yield

    app = FastAPI(title=title, description=description, version=version, lifespan=lifespan)
    install_problem_details(app)
    for router in routers:
        app.include_router(router)
    return app


__all__ = [
    "AuthenticatedCaller",
    "PlatformSettings",
    "ReadyCheck",
    "authenticated",
    "create_app",
    "health_router",
    "install_problem_details",
]

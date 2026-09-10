"""A service's own credential: obtained once, shared, and never leaked.

The interesting cases are all about what happens under concurrency and under
failure, because the happy path -- one caller, one token -- is the one that
works by accident.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from aia_auth import ServiceTokenProvider
from aia_auth.service_token import REFRESH_MARGIN_SECONDS
from aia_errors import DomainError

IDENTITY = "http://identity:3001"
TOKEN_URL = f"{IDENTITY}/v1/auth/token"


def provider(**overrides: object) -> ServiceTokenProvider:
    settings: dict[str, object] = {
        "identity_url": IDENTITY,
        "client_id": "aia-knowledge",
        "client_secret": "s3cret",
    }
    settings.update(overrides)
    return ServiceTokenProvider(**settings)  # type: ignore[arg-type]


def issued(token: str = "jwt-1", expires_in: int = 3600) -> httpx.Response:
    return httpx.Response(200, json={"access_token": token, "expires_in": expires_in})


async def test_a_service_without_a_credential_asks_for_nothing() -> None:
    """A missing credential disables what needs it; it does not fail the service.

    Same rule as a missing provider key (ADR-015). Reaching identity here would
    turn "not configured" into an outage at every call site.
    """
    with respx.mock:
        route = respx.post(TOKEN_URL).mock(return_value=issued())
        assert await provider(client_secret="").get() == ""
        assert await provider(client_id="").get() == ""
        assert route.call_count == 0


async def test_the_token_is_fetched_once_and_reused() -> None:
    with respx.mock:
        route = respx.post(TOKEN_URL).mock(return_value=issued())
        subject = provider()

        assert await subject.get() == "jwt-1"
        assert await subject.get() == "jwt-1"
        assert route.call_count == 1


async def test_a_token_inside_the_refresh_margin_is_not_reused() -> None:
    """Refreshing at the exact moment of expiry loses an in-flight request to
    nothing worse than clock skew between two containers."""
    with respx.mock:
        route = respx.post(TOKEN_URL).mock(
            side_effect=[
                issued("jwt-1", expires_in=int(REFRESH_MARGIN_SECONDS) - 1),
                issued("jwt-2"),
            ]
        )
        subject = provider()

        assert await subject.get() == "jwt-1"
        assert await subject.get() == "jwt-2"
        assert route.call_count == 2


async def test_invalidate_forces_the_next_call_to_fetch_again() -> None:
    """Called when a dependency answers 401 on a token we still consider valid."""
    with respx.mock:
        route = respx.post(TOKEN_URL).mock(side_effect=[issued("jwt-1"), issued("jwt-2")])
        subject = provider()

        assert await subject.get() == "jwt-1"
        subject.invalidate()
        assert await subject.get() == "jwt-2"
        assert route.call_count == 2


async def test_the_credentials_and_the_scope_travel_in_the_body() -> None:
    with respx.mock:
        route = respx.post(TOKEN_URL).mock(return_value=issued())
        await provider(scope="registry:read").get()

        assert route.calls.last.request.read() == (
            b'{"grant_type":"client_credentials","client_id":"aia-knowledge",'
            b'"client_secret":"s3cret","scope":"registry:read"}'
        )


async def test_the_scope_is_omitted_when_there_is_none() -> None:
    """`"scope": null` is not the same request as no scope at all."""
    with respx.mock:
        route = respx.post(TOKEN_URL).mock(return_value=issued())
        await provider().get()

        assert b"scope" not in route.calls.last.request.read()


# --- Concurrency -----------------------------------------------------------


class GatedIdentity:
    """An identity service that answers only once released.

    A fake rather than a sleep: a test that waits on wall-clock time is a test
    that is flaky on a loaded CI runner.
    """

    def __init__(self) -> None:
        self.released = asyncio.Event()
        self.calls = 0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        await self.released.wait()
        return issued(f"jwt-{self.calls}")


async def test_concurrent_callers_share_one_login() -> None:
    """A cold start under load must not fire one login per in-flight request,
    against the service that is already the busiest thing in the platform."""
    identity = GatedIdentity()
    with respx.mock:
        respx.post(TOKEN_URL).mock(side_effect=identity)
        subject = provider()

        callers = [asyncio.create_task(subject.get()) for _ in range(5)]
        await asyncio.sleep(0)
        identity.released.set()

        assert await asyncio.gather(*callers) == ["jwt-1"] * 5
        assert identity.calls == 1


async def test_a_cancelled_caller_does_not_cancel_the_refresh() -> None:
    """The `shield`. Without it, one caller timing out takes the token away from
    every other caller waiting on the same fetch."""
    identity = GatedIdentity()
    with respx.mock:
        respx.post(TOKEN_URL).mock(side_effect=identity)
        subject = provider()

        impatient = asyncio.create_task(subject.get())
        patient = asyncio.create_task(subject.get())
        await asyncio.sleep(0)
        impatient.cancel()
        identity.released.set()

        assert await patient == "jwt-1"
        assert identity.calls == 1
        with pytest.raises(asyncio.CancelledError):
            await impatient


# --- Failure ---------------------------------------------------------------


async def test_identity_refusing_the_credential_raises_without_repeating_it() -> None:
    """Identity's answer about a credential is not the requesting user's
    business, and its body is exactly where a secret would surface."""
    with respx.mock:
        respx.post(TOKEN_URL).mock(
            return_value=httpx.Response(
                401, json={"detail": "invalid client_secret s3cret for aia-knowledge"}
            )
        )
        subject = provider()

        with pytest.raises(DomainError) as raised:
            await subject.get()

        assert raised.value.status == 500
        assert "s3cret" not in str(raised.value)
        assert "401" in str(raised.value)


async def test_a_failed_fetch_does_not_poison_the_next_attempt() -> None:
    """The task holding the failure is done, so the next caller starts a new one
    rather than awaiting the exception forever."""
    with respx.mock:
        respx.post(TOKEN_URL).mock(side_effect=[httpx.Response(503), issued("jwt-1")])
        subject = provider()

        with pytest.raises(DomainError):
            await subject.get()
        assert await subject.get() == "jwt-1"

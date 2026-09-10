"""A service's own credential, for calling another service on nobody's behalf.

Mirrors `packages/nest/src/service-token.ts`, and replaces the managed identity
a cloud would provide (doc 02 §6, ADR-012).

It lives in `aia_auth` rather than in `aia_fastapi` because fetching a token
needs no web framework, and the first service that will need it consumes a
queue and has no HTTP port at all: beside FastAPI it would make a worker depend
on a server it never starts.

No Python service calls it TODAY, and that is not an oversight. Both existing
ones act as the caller and carry the user's own token onwards (ADR-017), which
is the correct choice wherever a request has a user behind it. A service token
is for the other case -- a scheduled job, a queue consumer, a reconciliation --
and the platform does not have one in Python yet.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

import httpx

from aia_errors import InternalError

logger = logging.getLogger(__name__)

#: Refresh BEFORE expiry. Refreshing at the exact moment would fail an in-flight
#: request over nothing worse than clock skew between two containers.
REFRESH_MARGIN_SECONDS = 60.0


@dataclass(slots=True)
class ServiceTokenProvider:
    """Obtains and reuses a `client_credentials` token from aia-identity."""

    identity_url: str
    client_id: str
    client_secret: str
    scope: str | None = None
    timeout_seconds: float = 5.0
    _token: str | None = field(default=None, init=False)
    _expires_at: float = field(default=0.0, init=False)
    _refresh: asyncio.Task[str] | None = field(default=None, init=False)

    @property
    def configured(self) -> bool:
        """A service with no credential is not broken, it is unconfigured.

        Same rule as a missing provider key: it disables what needs it rather
        than bringing the service down (ADR-015).
        """
        return bool(self.client_id) and bool(self.client_secret)

    async def get(self) -> str:
        if not self.configured:
            return ""
        if self._token is not None and time.monotonic() < self._expires_at:
            return self._token

        # One refresh shared by every concurrent caller. Without it a cold start
        # under load fires one login per in-flight request, against the service
        # that is already the busiest thing in the platform.
        if self._refresh is None or self._refresh.done():
            self._refresh = asyncio.create_task(self._fetch())

        # `shield`, so a caller that times out and is cancelled does not cancel
        # the refresh every other caller is waiting on.
        return await asyncio.shield(self._refresh)

    def invalidate(self) -> None:
        """Discards the token. Called when a dependency answers 401."""
        self._token = None
        self._expires_at = 0.0

    async def _fetch(self) -> str:
        body: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        if self.scope is not None:
            body["scope"] = self.scope

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(f"{self.identity_url}/v1/auth/token", json=body)

        if response.status_code != httpx.codes.OK:
            # The body goes to the log, never to the caller: it is identity's
            # answer about a credential, and a service token failure is not the
            # requesting user's business.
            logger.error(
                "could not obtain a service token (%s): %s",
                response.status_code,
                response.text[:200],
            )
            raise InternalError(
                f"identity responded {response.status_code} when issuing a service token"
            )

        payload = response.json()
        self._token = str(payload["access_token"])
        self._expires_at = time.monotonic() + float(payload["expires_in"]) - REFRESH_MARGIN_SECONDS
        logger.info("service token obtained, valid for %ss", payload["expires_in"])
        return self._token

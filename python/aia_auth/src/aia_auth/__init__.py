"""Local JWT validation with a cached JWKS (ADR-004).

No call to the identity service on the request path: the public keys are
fetched once and reused until they expire.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Final

import httpx
import jwt
from jwt import PyJWKClient

from aia_contracts import MAX_ZONES_BY_CLASSIFICATION
from aia_errors import DomainError, ErrorCode, ForbiddenError, UnauthenticatedError

ROLES: Final[frozenset[str]] = frozenset(
    {
        "platform_admin",
        "project_owner",
        "project_editor",
        "project_viewer",
        "auditor",
    }
)

#: ADR-010: maximum zones per classification. A policy may narrow, never widen.
#:
#: Re-exported from the contract rather than written here (ADR-027). It used to
#: be a literal in this file AND in packages/auth AND in aia-governance's domain
#: AND in the console's -- four independent copies of the one rule that decides
#: whether restricted data may leave the machine, with nothing comparing them.
ZONES_BY_CLASSIFICATION: Final[dict[str, tuple[str, ...]]] = MAX_ZONES_BY_CLASSIFICATION


class TokenExpiredError(DomainError):
    def __init__(self) -> None:
        super().__init__("Token expired", code=ErrorCode.TOKEN_EXPIRED, status=401)


class InvalidTokenError(DomainError):
    def __init__(self, reason: str) -> None:
        super().__init__(
            "Invalid token",
            code=ErrorCode.INVALID_TOKEN,
            status=401,
            details={"reason": reason},
        )


@dataclass(frozen=True, slots=True)
class ProjectMembership:
    project_id: str
    roles: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Principal:
    id: str
    type: str
    issuer: str
    expires_at: float
    email: str | None = None
    display_name: str | None = None
    global_roles: tuple[str, ...] = ()
    memberships: tuple[ProjectMembership, ...] = ()
    scopes: tuple[str, ...] = ()

    def roles_in(self, project_id: str) -> tuple[str, ...]:
        for membership in self.memberships:
            if membership.project_id == project_id:
                return (*self.global_roles, *membership.roles)
        return self.global_roles

    @property
    def is_platform_admin(self) -> bool:
        return "platform_admin" in self.global_roles

    def belongs_to(self, project_id: str) -> bool:
        return any(m.project_id == project_id for m in self.memberships)


def _parse_roles(raw: Any) -> tuple[str, ...]:
    """An unknown role is DISCARDED, never accepted.

    A misconfigured external issuer must not be able to invent privilege.
    """
    if not isinstance(raw, list):
        return ()
    return tuple(role for role in raw if isinstance(role, str) and role in ROLES)


def _parse_memberships(raw: Any) -> tuple[ProjectMembership, ...]:
    if not isinstance(raw, list):
        return ()
    memberships: list[ProjectMembership] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        project_id = entry.get("project_id") or entry.get("projectId")
        if not isinstance(project_id, str) or not project_id:
            continue
        memberships.append(
            ProjectMembership(project_id=project_id, roles=_parse_roles(entry.get("roles")))
        )
    return tuple(memberships)


@dataclass(slots=True)
class JwtVerifier:
    issuer: str
    jwks_uri: str
    audience: str | None = None
    leeway_seconds: int = 5
    _client: PyJWKClient | None = field(default=None, init=False, repr=False)

    def _jwk_client(self) -> PyJWKClient:
        if self._client is None:
            self._client = PyJWKClient(self.jwks_uri, cache_keys=True, lifespan=600)
        return self._client

    def _decode(self, token: str) -> dict[str, Any]:
        signing_key = self._jwk_client().get_signing_key_from_jwt(token)
        decoded: dict[str, Any] = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=self.issuer,
            audience=self.audience,
            leeway=self.leeway_seconds,
            options={"require": ["exp", "sub", "iss"]},
        )
        return decoded

    def verify(self, token: str) -> Principal:
        try:
            claims = self._decode(token)
        except (jwt.InvalidSignatureError, jwt.PyJWKClientError):
            # An unknown signature almost always means a stale cached JWKS,
            # not a forged token: the issuer rotated its key. Reload ONCE and
            # retry; if it fails again, then it really is an invalid token.
            self._client = None
            try:
                claims = self._decode(token)
            except jwt.ExpiredSignatureError as error:
                raise TokenExpiredError() from error
            except (jwt.InvalidTokenError, httpx.HTTPError) as error:
                raise InvalidTokenError(type(error).__name__) from error
        except jwt.ExpiredSignatureError as error:
            raise TokenExpiredError() from error
        except (jwt.InvalidTokenError, httpx.HTTPError) as error:
            raise InvalidTokenError(type(error).__name__) from error

        principal_type = claims.get("principal_type", "user")
        if principal_type not in {"user", "application", "service"}:
            principal_type = "user"

        scope = claims.get("scope") or claims.get("scp") or ""

        return Principal(
            id=str(claims["sub"]),
            type=principal_type,
            issuer=self.issuer,
            expires_at=float(claims["exp"]),
            email=claims.get("email"),
            display_name=claims.get("name"),
            global_roles=_parse_roles(claims.get("roles")),
            memberships=_parse_memberships(claims.get("memberships")),
            scopes=tuple(part for part in scope.split(" ") if part),
        )


def bearer_token(authorization_header: str | None) -> str:
    if not authorization_header:
        raise UnauthenticatedError("Missing Authorization header")
    scheme, _, token = authorization_header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise UnauthenticatedError("Expected the Bearer scheme in the Authorization header")
    return token


def require_membership(principal: Principal, project_id: str) -> None:
    if principal.is_platform_admin or principal.belongs_to(project_id):
        return
    raise ForbiddenError("principal does not belong to the project", project_id=project_id)


def zone_is_compatible(classification: str, zone: str) -> bool:
    """ADR-010. An unknown classification fails CLOSED."""
    return zone in ZONES_BY_CLASSIFICATION.get(classification, ())


def is_expired(principal: Principal, now: float | None = None) -> bool:
    return principal.expires_at <= (now if now is not None else time.time())


__all__ = [
    "ROLES",
    "ZONES_BY_CLASSIFICATION",
    "InvalidTokenError",
    "JwtVerifier",
    "Principal",
    "ProjectMembership",
    "TokenExpiredError",
    "bearer_token",
    "is_expired",
    "require_membership",
    "zone_is_compatible",
]

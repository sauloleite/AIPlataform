"""Authorisation as composable specifications (reference doc 03 §4).

Mirrors `packages/auth/src/authorization.ts`. Python services had
`require_membership` and nothing else, so every one of them could ask exactly
one question -- "does this principal belong to the project?" -- and a denial
could not say which rule denied it. `ForbiddenError` on the TypeScript side
carries `details.rule`; here it carried only the project.

Composition uses `&`, `|` and `~` rather than `.and_()`, because that is what a
Python predicate object does. The rendered NAME keeps the English words, so the
audit string a Python service writes is byte-identical to the TypeScript one --
`(is a member of the project and data zone compatible with the classification)`
reads the same in a trace whichever service produced it.

This module is pure: no httpx, no clock, no I/O. `aia_auth/__init__.py` pulls
httpx for the JWKS verifier, so importing THAT from a service's domain breaks
the dependency rule -- importing this submodule does not.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol

from aia_contracts import MAX_ZONES_BY_CLASSIFICATION
from aia_errors import ForbiddenError


class _PrincipalLike(Protocol):
    """What a rule needs of a principal.

    A Protocol rather than the concrete `Principal`, so this module stays free
    of the package that imports httpx.
    """

    # Properties rather than plain attributes: a protocol attribute is settable,
    # and `Principal` is a frozen dataclass, so declaring them as fields makes
    # the real class fail to satisfy its own protocol.
    @property
    def scopes(self) -> tuple[str, ...]: ...
    @property
    def type(self) -> str: ...
    @property
    def is_platform_admin(self) -> bool: ...
    def roles_in(self, project_id: str) -> tuple[str, ...]: ...
    def belongs_to(self, project_id: str) -> bool: ...


@dataclass(frozen=True, slots=True)
class Decision:
    """Whether it is allowed, and WHY. The reason goes into the trace."""

    allowed: bool
    #: Short and stable. Never carries PII.
    reason: str


def allow(reason: str) -> Decision:
    return Decision(allowed=True, reason=reason)


def deny(reason: str) -> Decision:
    return Decision(allowed=False, reason=reason)


@dataclass(frozen=True, slots=True)
class AccessRequest:
    """What is being authorised: a principal acting on a project."""

    principal: _PrincipalLike
    project_id: str
    #: The project's classification, for the ABAC rules.
    data_classification: str | None = None
    #: Where the target resource processes data, e.g. where the model runs.
    target_data_zone: str | None = None
    #: Risk level of the tool being invoked.
    tool_risk_level: str | None = None


class Specification:
    """A rule that can be composed, tested alone, and named in an audit trail."""

    name: str

    def evaluate(self, request: AccessRequest) -> Decision:
        raise NotImplementedError

    def is_satisfied_by(self, request: AccessRequest) -> bool:
        return self.evaluate(request).allowed

    def __and__(self, other: Specification) -> Specification:
        return _And(self, other)

    def __or__(self, other: Specification) -> Specification:
        return _Or(self, other)

    def __invert__(self) -> Specification:
        return _Not(self)


class _And(Specification):
    def __init__(self, left: Specification, right: Specification) -> None:
        self.left, self.right = left, right
        self.name = f"({left.name} and {right.name})"

    def evaluate(self, request: AccessRequest) -> Decision:
        decision = self.left.evaluate(request)
        # Short circuit: the first denial carries the reason worth reporting.
        return decision if not decision.allowed else self.right.evaluate(request)


class _Or(Specification):
    def __init__(self, left: Specification, right: Specification) -> None:
        self.left, self.right = left, right
        self.name = f"({left.name} or {right.name})"

    def evaluate(self, request: AccessRequest) -> Decision:
        left = self.left.evaluate(request)
        if left.allowed:
            return left
        right = self.right.evaluate(request)
        if right.allowed:
            return right
        # Both reasons: with one of them the caller fixes half the problem and
        # is denied again.
        return deny(f"{left.reason}; {right.reason}")


class _Not(Specification):
    def __init__(self, inner: Specification) -> None:
        self.inner = inner
        self.name = f"not {inner.name}"

    def evaluate(self, request: AccessRequest) -> Decision:
        decision = self.inner.evaluate(request)
        return deny(f"denied by {self.inner.name}") if decision.allowed else allow(self.name)


class _Predicate(Specification):
    """A specification built from a plain function."""

    def __init__(
        self, name: str, predicate: Callable[[AccessRequest], bool], deny_reason: str
    ) -> None:
        self.name = name
        self._predicate = predicate
        self._deny_reason = deny_reason

    def evaluate(self, request: AccessRequest) -> Decision:
        return allow(self.name) if self._predicate(request) else deny(self._deny_reason)


def spec(name: str, predicate: Callable[[AccessRequest], bool], deny_reason: str) -> Specification:
    return _Predicate(name, predicate, deny_reason)


class _HasRoleInProject(Specification):
    def __init__(self, roles: tuple[str, ...]) -> None:
        self.roles = roles
        self.name = f"has one of the roles [{', '.join(roles)}]"

    def evaluate(self, request: AccessRequest) -> Decision:
        if request.principal.is_platform_admin:
            return allow("platform_admin")
        granted = request.principal.roles_in(request.project_id)
        match = next((role for role in self.roles if role in granted), None)
        if match is None:
            return deny(f"principal has none of {', '.join(self.roles)} on the project")
        return allow(f"role {match}")


def has_role(*roles: str) -> Specification:
    return _HasRoleInProject(roles)


is_member_of_project: Final[Specification] = spec(
    "is a member of the project",
    lambda request: (
        request.principal.is_platform_admin or request.principal.belongs_to(request.project_id)
    ),
    "principal does not belong to the project",
)


is_internal_service: Final[Specification] = spec(
    "is an internal service",
    lambda request: request.principal.type == "service",
    "principal is not an internal service",
)
"""A service calling another service on nobody's behalf.

Named, rather than the `if principal.type != "service"` it replaces. That `if`
sat at four call sites and was the widest authorisation bypass on the platform:
an internal service reaching a project it is not a member of. Written as a rule
it composes -- `is_internal_service | POLICY.READ_PROJECT` -- and, more to the
point, the decision records WHICH branch allowed the call, so a trace shows that
the bypass fired instead of showing nothing at all.
"""


def has_scope(scope: str) -> Specification:
    return spec(
        f"has the {scope} scope",
        lambda request: scope in request.principal.scopes or "*" in request.principal.scopes,
        f"token does not carry the {scope} scope",
    )


class _DataZoneIsCompatible(Specification):
    """ADR-010: classified data may only reach a compatible zone."""

    name = "data zone compatible with the classification"

    def evaluate(self, request: AccessRequest) -> Decision:
        if request.data_classification is None or request.target_data_zone is None:
            return allow("not a routing decision")
        # An unknown classification is denied: fail closed (doc 02 §10).
        allowed = MAX_ZONES_BY_CLASSIFICATION.get(request.data_classification, ())
        if request.target_data_zone in allowed:
            return allow(f"{request.target_data_zone} is allowed for {request.data_classification}")
        return deny("the target's data zone is not compatible with the project classification")


data_zone_is_compatible: Final[Specification] = _DataZoneIsCompatible()


class _CanInvokeToolRisk(Specification):
    """OWASP LLM06: a high-risk tool requires an owner or admin role.

    Fails CLOSED on a level it does not recognise, the same way
    `data_zone_is_compatible` does. The TypeScript twin tested `!== 'high'` and
    allowed everything else until this was written.
    """

    name = "may invoke a tool at this risk level"

    def evaluate(self, request: AccessRequest) -> Decision:
        level = request.tool_risk_level
        if level is None:
            return allow("not a tool invocation")
        if level in ("low", "medium"):
            return allow("risk level needs no elevated role")
        return has_role("project_owner").evaluate(request)


can_invoke_tool_risk: Final[Specification] = _CanInvokeToolRisk()


class POLICY:
    """Ready-made policies for the common cases. Same names as TypeScript."""

    READ_PROJECT: Final = is_member_of_project
    USE_INFERENCE: Final = is_member_of_project & data_zone_is_compatible
    EDIT_ASSETS: Final = has_role("project_owner", "project_editor")
    MANAGE_BUDGET: Final = has_role("project_owner")
    READ_AUDIT: Final = has_role("project_owner", "auditor")


def authorize(specification: Specification, request: AccessRequest) -> dict[str, str]:
    """Applies a specification and raises when it denies.

    Returns the rule and the reason so the caller can put them in the trace:
    doc 02 §6 asks for an auditable authorisation decision, which means the
    ALLOW is recorded too, not only the refusal.
    """
    decision = specification.evaluate(request)
    if not decision.allowed:
        raise ForbiddenError(
            decision.reason, rule=specification.name, project_id=request.project_id
        )
    return {"rule": specification.name, "reason": decision.reason}

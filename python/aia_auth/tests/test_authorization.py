"""Authorisation, and that a denial says which rule denied it.

Python services had `require_membership` and nothing else: one question, and a
`ForbiddenError` that carried the project and not the rule. This is the mirror
of `packages/auth/src/authorization.ts`, including the rendered rule name --
which has to match, because it is what an auditor reads out of a trace, and a
platform that names one rule two ways has two vocabularies for one decision.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aia_auth import (
    POLICY,
    AccessRequest,
    Principal,
    ProjectMembership,
    authorize,
    can_invoke_tool_risk,
    data_zone_is_compatible,
    has_role,
    has_scope,
    is_member_of_project,
)
from aia_errors import ForbiddenError

ROOT = Path(__file__).resolve().parents[3]
AUTHORIZATION_TS = ROOT / "packages/auth/src/authorization.ts"


def principal(
    *,
    roles: tuple[str, ...] = (),
    global_roles: tuple[str, ...] = (),
    scopes: tuple[str, ...] = (),
) -> Principal:
    return Principal(
        id="user-ana",
        type="user",
        issuer="https://identity",
        expires_at=0,
        scopes=scopes,
        global_roles=global_roles,
        memberships=(ProjectMembership("proj-1", roles),),
    )


def request(**overrides: object) -> AccessRequest:
    base: dict[str, object] = {"principal": principal(), "project_id": "proj-1"}
    base.update(overrides)
    return AccessRequest(**base)  # type: ignore[arg-type]


class TestMembership:
    def test_a_member_is_allowed(self) -> None:
        assert is_member_of_project.is_satisfied_by(request())

    def test_a_stranger_is_denied(self) -> None:
        assert not is_member_of_project.is_satisfied_by(request(project_id="proj-2"))

    def test_a_platform_admin_belongs_everywhere(self) -> None:
        admin = principal(global_roles=("platform_admin",))
        assert is_member_of_project.is_satisfied_by(
            request(principal=admin, project_id="somebody-elses")
        )


class TestRoles:
    def test_the_role_the_caller_holds_is_named_in_the_reason(self) -> None:
        owner = principal(roles=("project_owner",))
        decision = has_role("project_owner").evaluate(request(principal=owner))

        # The reason goes into the trace. "allowed" alone tells an auditor
        # nothing about WHY.
        assert decision.reason == "role project_owner"

    def test_a_missing_role_says_which_ones_were_wanted(self) -> None:
        decision = has_role("project_owner", "auditor").evaluate(request())

        assert not decision.allowed
        assert "project_owner, auditor" in decision.reason


class TestScopes:
    def test_a_wildcard_scope_satisfies_any(self) -> None:
        wildcard = principal(scopes=("*",))
        assert has_scope("projects:read").is_satisfied_by(request(principal=wildcard))

    def test_a_token_without_the_scope_is_denied(self) -> None:
        narrow = principal(scopes=("projects:read",))
        assert not has_scope("projects:write").is_satisfied_by(request(principal=narrow))


class TestDataZones:
    """ADR-010, and it fails closed."""

    def test_restricted_reaches_local_and_nothing_else(self) -> None:
        assert data_zone_is_compatible.is_satisfied_by(
            request(data_classification="restricted", target_data_zone="local")
        )
        assert not data_zone_is_compatible.is_satisfied_by(
            request(data_classification="restricted", target_data_zone="us")
        )

    def test_an_unknown_classification_is_denied(self) -> None:
        assert not data_zone_is_compatible.is_satisfied_by(
            request(data_classification="made-up", target_data_zone="local")
        )

    def test_it_says_nothing_when_it_is_not_a_routing_decision(self) -> None:
        assert data_zone_is_compatible.is_satisfied_by(request())


class TestToolRisk:
    """OWASP LLM06, and it fails closed the same way."""

    def test_low_and_medium_need_no_elevated_role(self) -> None:
        assert can_invoke_tool_risk.is_satisfied_by(request(tool_risk_level="low"))
        assert can_invoke_tool_risk.is_satisfied_by(request(tool_risk_level="medium"))

    def test_high_requires_the_owner(self) -> None:
        assert not can_invoke_tool_risk.is_satisfied_by(request(tool_risk_level="high"))
        owner = principal(roles=("project_owner",))
        assert can_invoke_tool_risk.is_satisfied_by(
            request(principal=owner, tool_risk_level="high")
        )

    def test_a_level_it_does_not_recognise_is_treated_as_the_most_dangerous(self) -> None:
        assert not can_invoke_tool_risk.is_satisfied_by(request(tool_risk_level="critical"))
        assert not can_invoke_tool_risk.is_satisfied_by(request(tool_risk_level="HIGH"))


class TestComposition:
    def test_and_short_circuits_on_the_first_denial(self) -> None:
        combined = is_member_of_project & data_zone_is_compatible
        decision = combined.evaluate(request(project_id="proj-2", data_classification="restricted"))

        # The FIRST reason, not the last: the caller fixes what actually stopped
        # them rather than the next thing down the chain.
        assert decision.reason == "principal does not belong to the project"

    def test_or_reports_both_reasons_when_both_deny(self) -> None:
        combined = has_role("auditor") | has_scope("audit:read")
        decision = combined.evaluate(request())

        assert not decision.allowed
        assert ";" in decision.reason

    def test_not_inverts(self) -> None:
        assert (~is_member_of_project).is_satisfied_by(request(project_id="proj-2"))


class TestAuthorize:
    def test_it_returns_the_rule_and_the_reason_on_success(self) -> None:
        result = authorize(POLICY.READ_PROJECT, request())

        # The ALLOW is recorded too, not only the refusal: doc 02 §6 asks for an
        # auditable decision, and half a record is not one.
        assert result["rule"] == "is a member of the project"

    def test_it_raises_forbidden_carrying_the_rule(self) -> None:
        with pytest.raises(ForbiddenError) as raised:
            authorize(POLICY.MANAGE_BUDGET, request())

        assert raised.value.status == 403
        # `details.rule` is what TypeScript carries and what this used to lack:
        # a denial that cannot say which rule denied it.
        assert raised.value.details["rule"] == "has one of the roles [project_owner]"
        assert raised.value.details["project_id"] == "proj-1"


class TestTheRuleNamesMatchTypeScript:
    """The rendered name is an audit string, and it crosses languages."""

    def test_the_composed_policy_reads_the_same(self) -> None:
        assert POLICY.USE_INFERENCE.name == (
            "(is a member of the project and data zone compatible with the classification)"
        )

    def test_each_named_rule_matches_its_typescript_spelling(self) -> None:
        source = AUTHORIZATION_TS.read_text()

        for name in (
            "is a member of the project",
            "data zone compatible with the classification",
            "may invoke a tool at this risk level",
        ):
            assert f"'{name}'" in source, f"TypeScript no longer spells it {name!r}"

        assert is_member_of_project.name == "is a member of the project"
        assert data_zone_is_compatible.name == "data zone compatible with the classification"
        assert can_invoke_tool_risk.name == "may invoke a tool at this risk level"

    def test_the_role_rule_renders_the_same_shape(self) -> None:
        source = AUTHORIZATION_TS.read_text()
        assert "has one of the roles [${roles.join(', ')}]" in source

        assert has_role("project_owner", "auditor").name == (
            "has one of the roles [project_owner, auditor]"
        )

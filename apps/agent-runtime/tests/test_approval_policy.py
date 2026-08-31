"""The pure rules: who may approve, and when the loop has to stop.

No database, no clock, no service. `ApproveToolCall` used to live beside these;
the approval path is now one branch of `RunAgent`, exercised in
`test_run_agent.py` against the whole loop rather than in isolation.
"""

from __future__ import annotations

import pytest

from agent_runtime.domain.entities import ToolCall
from agent_runtime.domain.policies import ApprovalPolicy, LoopPolicy

VIEWER = frozenset({"project_viewer"})
OWNER = frozenset({"project_owner"})


def a_call(risk: str = "high", *, binding_requires: bool = False) -> ToolCall:
    return ToolCall(
        id="call-1",
        tool_name="merge-request",
        tool_id="tool-merge",
        arguments={"mr": 42},
        risk_level=risk,
        requires_approval=binding_requires,
    )


class TestApprovalPolicy:
    def test_a_high_risk_tool_needs_approval(self) -> None:
        assert ApprovalPolicy.requires_approval(a_call("high"))

    @pytest.mark.parametrize("risk", ["low", "medium"])
    def test_a_lower_risk_tool_does_not(self, risk: str) -> None:
        assert not ApprovalPolicy.requires_approval(a_call(risk))

    def test_a_binding_can_raise_the_bar_on_a_low_risk_tool(self) -> None:
        assert ApprovalPolicy.requires_approval(a_call("low", binding_requires=True))

    def test_a_binding_cannot_lower_it(self) -> None:
        # `require_approval: false` on a high-risk tool is a configuration
        # mistake waiting to become an incident, not an instruction.
        assert ApprovalPolicy.requires_approval(a_call("high", binding_requires=False))

    def test_a_viewer_does_not_approve_high_risk(self) -> None:
        assert not ApprovalPolicy.can_approve(VIEWER, a_call("high"))

    def test_an_owner_does(self) -> None:
        assert ApprovalPolicy.can_approve(OWNER, a_call("high"))

    def test_the_role_is_irrelevant_at_low_risk(self) -> None:
        assert ApprovalPolicy.can_approve(VIEWER, a_call("low"))

    def test_detects_a_self_approval(self) -> None:
        assert ApprovalPolicy.is_self_approval("user-1", "user-1")
        assert not ApprovalPolicy.is_self_approval("user-1", "user-2")


class TestLoopPolicy:
    def test_the_loop_is_exhausted_at_the_ceiling(self) -> None:
        assert LoopPolicy.exhausted(3, max_steps=3)
        assert not LoopPolicy.exhausted(2, max_steps=3)

    def test_the_warning_lands_one_step_short(self) -> None:
        assert LoopPolicy.last_chance(2, max_steps=3)
        assert not LoopPolicy.last_chance(1, max_steps=3)
        assert not LoopPolicy.last_chance(3, max_steps=3)

    def test_a_ceiling_of_one_warns_before_the_first_call(self) -> None:
        # Otherwise a max_steps of 1 would spend a turn and then fail, instead
        # of asking for an answer with no tools at all.
        assert LoopPolicy.last_chance(0, max_steps=1)

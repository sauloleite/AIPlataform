"""Pure runtime policies.

`ApprovalPolicy` implements the LLM06 (excessive agency) control from reference
doc 02: a high-risk tool does not run without human approval, and whoever
approves needs a role that allows it.
"""

from __future__ import annotations

from enum import StrEnum

from agent_runtime.domain.entities import ToolCall


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ApprovalPolicy:
    """Pure rule: reads no database, calls no service, looks at no clock."""

    #: Roles that may approve a high-risk tool.
    APPROVER_ROLES = frozenset({"project_owner", "platform_admin"})

    @staticmethod
    def requires_approval(call: ToolCall) -> bool:
        """High risk always, plus whatever the project's binding raised.

        A binding can RAISE the bar and never lower it: `requires_approval`
        arrives from aia-mcp-gateway already combining the two, and the runtime
        must not talk itself out of a control the gateway will enforce anyway.
        """
        return call.risk_level == RiskLevel.HIGH or call.requires_approval

    @classmethod
    def can_approve(cls, roles: frozenset[str] | set[str], call: ToolCall) -> bool:
        if not cls.requires_approval(call):
            return True
        return bool(cls.APPROVER_ROLES & set(roles))

    @staticmethod
    def is_self_approval(principal_id: str, run_principal_id: str) -> bool:
        """Whoever started the run should not approve their own risky tool.

        Segregation of duties: the same person asking and authorising hollows
        out the control. The caller decides whether to enforce it, because on a
        small team it can stall the operation.
        """
        return principal_id == run_principal_id


class LoopPolicy:
    """When the loop has to stop.

    An agent that keeps answering itself spends real money in silence. The
    ceiling is on TOOL steps, not on messages: an ordinary answer ends the run
    on its own, and it is the call-result-call cycle that can run away.
    """

    @staticmethod
    def exhausted(tool_calls_made: int, max_steps: int) -> bool:
        return tool_calls_made >= max_steps

    @staticmethod
    def last_chance(tool_calls_made: int, max_steps: int) -> bool:
        """One step short of the ceiling.

        On this turn the model is told to answer with what it has instead of
        calling again, so the run ends with an answer rather than with the step
        limit -- a limit reached is a failure the user sees.
        """
        return tool_calls_made == max_steps - 1

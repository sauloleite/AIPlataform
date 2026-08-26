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
        return call.risk_level == RiskLevel.HIGH

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

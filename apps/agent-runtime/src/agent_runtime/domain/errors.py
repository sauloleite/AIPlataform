"""Runtime domain errors."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class RunNotFoundError(DomainError):
    def __init__(self, run_id: str) -> None:
        super().__init__(
            "Run not found",
            code=ErrorCode.NOT_FOUND,
            status=404,
            details={"run_id": run_id},
        )


class RunNotWaitingApprovalError(DomainError):
    def __init__(self, run_id: str, tool_call_id: str | None = None) -> None:
        super().__init__(
            "The run is not waiting for approval on that call",
            code=ErrorCode.CONFLICT,
            status=409,
            details={
                "run_id": run_id,
                **({"tool_call_id": tool_call_id} if tool_call_id is not None else {}),
            },
        )


class AgentNotPublishedError(DomainError):
    """A run pins a published version. Falling back to a draft would execute
    something nobody reviewed, which is the drift the registry exists to stop."""

    def __init__(self, agent_id: str) -> None:
        super().__init__(
            "The agent has no published version to run",
            code=ErrorCode.ASSET_NOT_PUBLISHED,
            status=404,
            details={"agent_id": agent_id},
        )


class AgentStepLimitError(DomainError):
    def __init__(self, run_id: str, max_steps: int) -> None:
        super().__init__(
            "The agent kept calling tools without reaching an answer",
            code=ErrorCode.AGENT_STEP_LIMIT,
            status=409,
            details={"run_id": run_id, "max_steps": max_steps},
        )


class ApprovalForbiddenError(DomainError):
    def __init__(self, principal_id: str, risk_level: str) -> None:
        super().__init__(
            "The principal cannot approve a tool at this risk level",
            code=ErrorCode.FORBIDDEN,
            status=403,
            details={"principal_id": principal_id, "risk_level": risk_level},
        )

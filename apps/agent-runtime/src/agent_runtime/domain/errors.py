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
    def __init__(self, run_id: str) -> None:
        super().__init__(
            "The run is not waiting for approval",
            code=ErrorCode.CONFLICT,
            status=409,
            details={"run_id": run_id},
        )


class ApprovalForbiddenError(DomainError):
    def __init__(self, principal_id: str, risk_level: str) -> None:
        super().__init__(
            "The principal cannot approve a tool at this risk level",
            code=ErrorCode.FORBIDDEN,
            status=403,
            details={"principal_id": principal_id, "risk_level": risk_level},
        )

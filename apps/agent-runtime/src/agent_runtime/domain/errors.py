"""Erros de dominio do runtime."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class RunNotFoundError(DomainError):
    def __init__(self, run_id: str) -> None:
        super().__init__(
            "Execucao nao encontrada",
            code=ErrorCode.NOT_FOUND,
            status=404,
            details={"run_id": run_id},
        )


class RunNotWaitingApprovalError(DomainError):
    def __init__(self, run_id: str) -> None:
        super().__init__(
            "A execucao nao esta aguardando aprovacao",
            code=ErrorCode.CONFLICT,
            status=409,
            details={"run_id": run_id},
        )


class ApprovalForbiddenError(DomainError):
    def __init__(self, principal_id: str, risk_level: str) -> None:
        super().__init__(
            "Principal nao pode aprovar uma tool deste nivel de risco",
            code=ErrorCode.FORBIDDEN,
            status=403,
            details={"principal_id": principal_id, "risk_level": risk_level},
        )

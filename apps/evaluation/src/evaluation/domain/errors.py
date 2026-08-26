"""Erros de dominio deste servico."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class ExemploError(DomainError):
    def __init__(self, detalhe: str) -> None:
        super().__init__(detalhe, code=ErrorCode.VALIDATION_FAILED, status=400)

"""Domain errors for this service."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class ExampleError(DomainError):
    def __init__(self, detail: str) -> None:
        super().__init__(detail, code=ErrorCode.VALIDATION_FAILED, status=400)

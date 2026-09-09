"""Domain errors and Problem Details (RFC 9457).

Mirrors `@aia/errors` on the TypeScript side: the same stable codes, so a client
reacts the same way regardless of which service answered.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final

PROBLEM_TYPE_BASE: Final = "https://aia.dev/errors"
PROBLEM_CONTENT_TYPE: Final = "application/problem+json"


class ErrorCode:
    """Stable codes. They are part of the public API contract."""

    BUDGET_EXHAUSTED: Final = "budget_exhausted"
    QUOTA_EXCEEDED: Final = "quota_exceeded"
    CONCURRENCY_LIMIT: Final = "concurrency_limit"
    NO_COMPATIBLE_DEPLOYMENT: Final = "no_compatible_deployment"
    ALIAS_NOT_FOUND: Final = "alias_not_found"
    PROVIDER_UNAVAILABLE: Final = "provider_unavailable"
    ALL_DEPLOYMENTS_FAILED: Final = "all_deployments_failed"
    STREAM_INTERRUPTED: Final = "stream_interrupted"
    GUARDRAIL_BLOCKED: Final = "guardrail_blocked"
    GUARDRAIL_UNAVAILABLE: Final = "guardrail_unavailable"
    PROMPT_INJECTION_SUSPECTED: Final = "prompt_injection_suspected"
    UNAUTHENTICATED: Final = "unauthenticated"
    FORBIDDEN: Final = "forbidden"
    TOKEN_EXPIRED: Final = "token_expired"  # noqa: S105 - error code, not a secret
    INVALID_TOKEN: Final = "invalid_token"  # noqa: S105 - error code, not a secret
    PROJECT_REQUIRED: Final = "project_required"
    PROJECT_NOT_FOUND: Final = "project_not_found"
    VALIDATION_FAILED: Final = "validation_failed"
    IDEMPOTENCY_CONFLICT: Final = "idempotency_conflict"
    NOT_FOUND: Final = "not_found"
    CONFLICT: Final = "conflict"
    ASSET_NOT_FOUND: Final = "asset_not_found"
    ASSET_NOT_PUBLISHED: Final = "asset_not_published"
    ASSET_VERSION_CONFLICT: Final = "asset_version_conflict"
    STORE_NOT_FOUND: Final = "store_not_found"
    DOCUMENT_NOT_FOUND: Final = "document_not_found"
    UNSUPPORTED_MEDIA_TYPE: Final = "unsupported_media_type"
    EMBEDDING_DIMENSION_MISMATCH: Final = "embedding_dimension_mismatch"
    INGESTION_FAILED: Final = "ingestion_failed"
    TOOL_NOT_FOUND: Final = "tool_not_found"
    TOOL_NOT_ALLOWED: Final = "tool_not_allowed"
    TOOL_ARGUMENTS_INVALID: Final = "tool_arguments_invalid"
    TOOL_RATE_LIMITED: Final = "tool_rate_limited"
    APPROVAL_REQUIRED: Final = "approval_required"
    TOOL_EXECUTION_FAILED: Final = "tool_execution_failed"
    AGENT_STEP_LIMIT: Final = "agent_step_limit"
    UPSTREAM_TIMEOUT: Final = "upstream_timeout"
    CIRCUIT_OPEN: Final = "circuit_open"
    INTERNAL_ERROR: Final = "internal_error"


# Every code in the catalogue has a title. An entry missing here would make a
# Python service answer with a generic title where the Node one answers with the
# real one, for the very same code -- and the mirror is the whole point.
_TITLES: Final[dict[str, str]] = {
    ErrorCode.BUDGET_EXHAUSTED: "Project budget exhausted",
    ErrorCode.QUOTA_EXCEEDED: "Quota exceeded",
    ErrorCode.CONCURRENCY_LIMIT: "Project concurrency limit reached",
    ErrorCode.NO_COMPATIBLE_DEPLOYMENT: (
        "No deployment compatible with the project data classification"
    ),
    ErrorCode.ALIAS_NOT_FOUND: "Unknown model alias",
    ErrorCode.PROVIDER_UNAVAILABLE: "Model provider unavailable",
    ErrorCode.ALL_DEPLOYMENTS_FAILED: "Every deployment for the alias failed",
    ErrorCode.STREAM_INTERRUPTED: "Stream interrupted",
    ErrorCode.GUARDRAIL_BLOCKED: "Content blocked by a guardrail",
    ErrorCode.GUARDRAIL_UNAVAILABLE: "Content cannot be inspected right now",
    ErrorCode.PROMPT_INJECTION_SUSPECTED: "Suspected prompt injection",
    ErrorCode.UNAUTHENTICATED: "Not authenticated",
    ErrorCode.FORBIDDEN: "Access denied",
    ErrorCode.TOKEN_EXPIRED: "Token expired",
    ErrorCode.INVALID_TOKEN: "Invalid token",
    ErrorCode.PROJECT_REQUIRED: "Project required",
    ErrorCode.PROJECT_NOT_FOUND: "Project not found",
    ErrorCode.VALIDATION_FAILED: "Invalid request",
    ErrorCode.IDEMPOTENCY_CONFLICT: "Idempotency conflict",
    ErrorCode.NOT_FOUND: "Resource not found",
    ErrorCode.CONFLICT: "State conflict",
    ErrorCode.ASSET_NOT_FOUND: "Asset not found",
    ErrorCode.ASSET_NOT_PUBLISHED: "Asset has no published version",
    ErrorCode.ASSET_VERSION_CONFLICT: "Asset changed since it was read",
    ErrorCode.STORE_NOT_FOUND: "Vector store not found",
    ErrorCode.DOCUMENT_NOT_FOUND: "Document not found",
    ErrorCode.UNSUPPORTED_MEDIA_TYPE: "No parser for this document type",
    ErrorCode.EMBEDDING_DIMENSION_MISMATCH: "Embedding dimension does not match the store",
    ErrorCode.INGESTION_FAILED: "Document ingestion failed",
    ErrorCode.TOOL_NOT_FOUND: "Tool not found",
    ErrorCode.TOOL_NOT_ALLOWED: "Tool not allowed for this project",
    ErrorCode.TOOL_ARGUMENTS_INVALID: "Tool arguments do not match its schema",
    ErrorCode.TOOL_RATE_LIMITED: "Tool rate limit reached",
    ErrorCode.APPROVAL_REQUIRED: "A human has to approve this tool call",
    ErrorCode.TOOL_EXECUTION_FAILED: "The tool failed to execute",
    ErrorCode.AGENT_STEP_LIMIT: "The agent reached its step limit without finishing",
    ErrorCode.UPSTREAM_TIMEOUT: "Dependency timed out",
    ErrorCode.CIRCUIT_OPEN: "Dependency circuit open",
    ErrorCode.INTERNAL_ERROR: "Internal error",
}


def title_for(code: str) -> str:
    return _TITLES.get(code, "Error")


@dataclass(slots=True)
class DomainError(Exception):
    """Root of every business exception.

    Presentation translates it into Problem Details; nothing here knows about
    HTTP beyond the suggested status.
    """

    message: str
    code: str = ErrorCode.INTERNAL_ERROR
    status: int = 500
    details: dict[str, Any] = field(default_factory=dict)
    retryable: bool = False

    def __post_init__(self) -> None:
        # Explicit `Exception.__init__`, not `super().__init__`.
        # `@dataclass(slots=True)` RECREATES the class, and the `__class__` cell
        # that zero-argument `super()` closes over still points at the old one.
        # In a subclass that raises "obj must be an instance or subtype of type".
        Exception.__init__(self, self.message)

    def to_problem(
        self, *, instance: str | None = None, trace_id: str | None = None
    ) -> dict[str, Any]:
        problem: dict[str, Any] = {
            "type": f"{PROBLEM_TYPE_BASE}/{self.code}",
            "title": title_for(self.code),
            "status": self.status,
            "detail": self.message,
            "code": self.code,
            **self.details,
        }
        if instance is not None:
            problem["instance"] = instance
        if trace_id is not None:
            problem["trace_id"] = trace_id
        return problem


class ValidationError(DomainError):
    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message, code=ErrorCode.VALIDATION_FAILED, status=400, details=details)


class NotFoundError(DomainError):
    def __init__(self, resource: str, identifier: str) -> None:
        super().__init__(
            f"{resource} not found",
            code=ErrorCode.NOT_FOUND,
            status=404,
            details={"resource": resource, "id": identifier},
        )


class UnauthenticatedError(DomainError):
    def __init__(self, message: str = "Missing or invalid credential") -> None:
        super().__init__(message, code=ErrorCode.UNAUTHENTICATED, status=401)


class ForbiddenError(DomainError):
    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message, code=ErrorCode.FORBIDDEN, status=403, details=details)


class ProjectRequiredError(DomainError):
    def __init__(self) -> None:
        super().__init__(
            "The X-Project-Id header is required: project is the platform tenant",
            code=ErrorCode.PROJECT_REQUIRED,
            status=400,
        )


class ConflictError(DomainError):
    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message, code=ErrorCode.CONFLICT, status=409, details=details)


class InternalError(DomainError):
    """Something went wrong that the caller can do nothing about.

    The message is for the LOG. `problem_from_unknown` never puts it in the
    response, because a 500 that explains itself explains it to whoever is
    probing.
    """

    def __init__(self, message: str = "Internal error", **details: Any) -> None:
        super().__init__(message, code=ErrorCode.INTERNAL_ERROR, status=500, details=details)


def is_domain_error(error: object) -> bool:
    """Whether this is one of ours, and therefore safe to return as it is."""
    return isinstance(error, DomainError)


def problem_type_for(code: str) -> str:
    """The `type` URI for a code, which is what RFC 9457 asks clients to branch on."""
    return f"{PROBLEM_TYPE_BASE}/{code}"


def problem_from_unknown(
    error: BaseException, *, instance: str | None = None, trace_id: str | None = None
) -> dict[str, Any]:
    """An unknown error becomes a 500 with NO detail.

    The internal message goes to the log, correlated by trace_id; exposing it in
    the response would hand infrastructure detail to whoever is probing.
    """
    if isinstance(error, DomainError):
        return error.to_problem(instance=instance, trace_id=trace_id)
    return DomainError("Internal error").to_problem(instance=instance, trace_id=trace_id)


__all__ = [
    "PROBLEM_CONTENT_TYPE",
    "PROBLEM_TYPE_BASE",
    "ConflictError",
    "InternalError",
    "is_domain_error",
    "problem_type_for",
    "DomainError",
    "ErrorCode",
    "ForbiddenError",
    "NotFoundError",
    "ProjectRequiredError",
    "UnauthenticatedError",
    "ValidationError",
    "problem_from_unknown",
    "title_for",
]

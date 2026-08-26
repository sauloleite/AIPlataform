"""Erros de dominio e Problem Details (RFC 9457).

Espelha o `@aia/errors` do lado TypeScript: os mesmos codigos estaveis, para que
um cliente reaja igual independente de qual servico respondeu.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final

PROBLEM_TYPE_BASE: Final = "https://aia.dev/errors"
PROBLEM_CONTENT_TYPE: Final = "application/problem+json"


class ErrorCode:
    """Codigos estaveis. Fazem parte do contrato publico da API."""

    BUDGET_EXHAUSTED: Final = "budget_exhausted"
    QUOTA_EXCEEDED: Final = "quota_exceeded"
    CONCURRENCY_LIMIT: Final = "concurrency_limit"
    NO_COMPATIBLE_DEPLOYMENT: Final = "no_compatible_deployment"
    ALIAS_NOT_FOUND: Final = "alias_not_found"
    PROVIDER_UNAVAILABLE: Final = "provider_unavailable"
    STREAM_INTERRUPTED: Final = "stream_interrupted"
    GUARDRAIL_BLOCKED: Final = "guardrail_blocked"
    PROMPT_INJECTION_SUSPECTED: Final = "prompt_injection_suspected"
    UNAUTHENTICATED: Final = "unauthenticated"
    FORBIDDEN: Final = "forbidden"
    TOKEN_EXPIRED: Final = "token_expired"  # noqa: S105 - codigo de erro, nao segredo
    INVALID_TOKEN: Final = "invalid_token"  # noqa: S105 - codigo de erro, nao segredo
    PROJECT_REQUIRED: Final = "project_required"
    PROJECT_NOT_FOUND: Final = "project_not_found"
    VALIDATION_FAILED: Final = "validation_failed"
    IDEMPOTENCY_CONFLICT: Final = "idempotency_conflict"
    NOT_FOUND: Final = "not_found"
    CONFLICT: Final = "conflict"
    UPSTREAM_TIMEOUT: Final = "upstream_timeout"
    CIRCUIT_OPEN: Final = "circuit_open"
    INTERNAL_ERROR: Final = "internal_error"


_TITLES: Final[dict[str, str]] = {
    ErrorCode.BUDGET_EXHAUSTED: "Orcamento do projeto esgotado",
    ErrorCode.GUARDRAIL_BLOCKED: "Conteudo bloqueado por guardrail",
    ErrorCode.PROMPT_INJECTION_SUSPECTED: "Suspeita de injecao de prompt",
    ErrorCode.UNAUTHENTICATED: "Nao autenticado",
    ErrorCode.FORBIDDEN: "Acesso negado",
    ErrorCode.TOKEN_EXPIRED: "Token expirado",
    ErrorCode.INVALID_TOKEN: "Token invalido",
    ErrorCode.PROJECT_REQUIRED: "Projeto obrigatorio",
    ErrorCode.PROJECT_NOT_FOUND: "Projeto nao encontrado",
    ErrorCode.VALIDATION_FAILED: "Requisicao invalida",
    ErrorCode.NOT_FOUND: "Recurso nao encontrado",
    ErrorCode.CONFLICT: "Conflito de estado",
    ErrorCode.UPSTREAM_TIMEOUT: "Tempo esgotado em dependencia",
    ErrorCode.CIRCUIT_OPEN: "Dependencia em circuito aberto",
    ErrorCode.INTERNAL_ERROR: "Erro interno",
}


def title_for(code: str) -> str:
    return _TITLES.get(code, "Erro")


@dataclass(slots=True)
class DomainError(Exception):
    """Raiz das excecoes de negocio.

    A apresentacao traduz para Problem Details; nada aqui sabe o que e HTTP
    alem do status sugerido.
    """

    message: str
    code: str = ErrorCode.INTERNAL_ERROR
    status: int = 500
    details: dict[str, Any] = field(default_factory=dict)
    retryable: bool = False

    def __post_init__(self) -> None:
        # `Exception.__init__` explicito, e nao `super().__init__`.
        # `@dataclass(slots=True)` RECRIA a classe, e a celula `__class__` que o
        # `super()` de argumento zero usa continua apontando para a classe antiga.
        # Em uma subclasse isso levanta "obj must be an instance or subtype of type".
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
            f"{resource} nao encontrado",
            code=ErrorCode.NOT_FOUND,
            status=404,
            details={"resource": resource, "id": identifier},
        )


class UnauthenticatedError(DomainError):
    def __init__(self, message: str = "Credencial ausente ou invalida") -> None:
        super().__init__(message, code=ErrorCode.UNAUTHENTICATED, status=401)


class ForbiddenError(DomainError):
    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message, code=ErrorCode.FORBIDDEN, status=403, details=details)


class ProjectRequiredError(DomainError):
    def __init__(self) -> None:
        super().__init__(
            "O header X-Project-Id e obrigatorio: projeto e o tenant da plataforma",
            code=ErrorCode.PROJECT_REQUIRED,
            status=400,
        )


def problem_from_unknown(
    error: BaseException, *, instance: str | None = None, trace_id: str | None = None
) -> dict[str, Any]:
    """Erro desconhecido vira 500 SEM detalhe.

    A mensagem interna vai para o log, correlacionada pelo trace_id; expo-la na
    resposta entregaria detalhe de infraestrutura a quem esta sondando.
    """
    if isinstance(error, DomainError):
        return error.to_problem(instance=instance, trace_id=trace_id)
    return DomainError("Erro interno").to_problem(instance=instance, trace_id=trace_id)


__all__ = [
    "PROBLEM_CONTENT_TYPE",
    "PROBLEM_TYPE_BASE",
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

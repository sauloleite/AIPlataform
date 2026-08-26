"""Regressao: `@dataclass(slots=True)` quebra `super()` de argumento zero.

O bug so aparece ao instanciar uma SUBCLASSE, entao um teste que exercite apenas
`DomainError` diretamente passaria sem detectar nada.
"""

from __future__ import annotations

import pytest

from aia_errors import (
    DomainError,
    ErrorCode,
    ForbiddenError,
    NotFoundError,
    ProjectRequiredError,
    UnauthenticatedError,
    ValidationError,
    problem_from_unknown,
)


class CustomError(DomainError):
    def __init__(self, target: str) -> None:
        super().__init__(
            "falha customizada",
            code=ErrorCode.CONFLICT,
            status=409,
            details={"target": target},
        )


@pytest.mark.parametrize(
    "factory",
    [
        lambda: ValidationError("invalido", field="slug"),
        lambda: NotFoundError("Projeto", "proj-1"),
        lambda: ForbiddenError("negado", rule="owner"),
        lambda: UnauthenticatedError(),
        lambda: ProjectRequiredError(),
        lambda: CustomError("mongo"),
    ],
)
def test_subclasse_instancia_e_carrega_a_mensagem(factory: object) -> None:
    error = factory()  # type: ignore[operator]
    assert isinstance(error, DomainError)
    assert isinstance(error, Exception)
    assert str(error) == error.message
    assert error.args == (error.message,)


def test_subclasse_pode_ser_levantada_e_capturada() -> None:
    with pytest.raises(ValidationError) as captured:
        raise ValidationError("slug invalido", slug="XX")

    assert captured.value.code == ErrorCode.VALIDATION_FAILED
    assert captured.value.details == {"slug": "XX"}


def test_problem_details_carrega_codigo_estavel_e_extensoes() -> None:
    problem = NotFoundError("Projeto", "proj-9").to_problem(
        instance="/v1/projects/proj-9", trace_id="abc123"
    )

    assert problem == {
        "type": "https://aia.dev/errors/not_found",
        "title": "Recurso nao encontrado",
        "status": 404,
        "detail": "Projeto nao encontrado",
        "code": "not_found",
        "resource": "Projeto",
        "id": "proj-9",
        "instance": "/v1/projects/proj-9",
        "trace_id": "abc123",
    }


def test_erro_desconhecido_nao_vaza_detalhe_interno() -> None:
    problem = problem_from_unknown(RuntimeError("conexao recusada em mongo://interno:27017"))

    assert problem["status"] == 500
    assert problem["code"] == "internal_error"
    assert "mongo://" not in str(problem)

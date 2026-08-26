"""Teste do caso de uso de exemplo."""

from __future__ import annotations

from evaluation.application.dto import ExemploCommand
from evaluation.application.use_cases.exemplo import ExecutarExemplo
from evaluation.infrastructure.in_memory import InMemoryExemploRepository


async def test_cria_e_persiste() -> None:
    repository = InMemoryExemploRepository()
    resultado = await ExecutarExemplo(repository=repository).execute(
        ExemploCommand(project_id="proj-1")
    )

    assert resultado.project_id == "proj-1"
    assert await repository.find(resultado.id) == resultado

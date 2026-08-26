"""Test for the placeholder use case."""

from __future__ import annotations

from evaluation.application.dto import ExampleCommand
from evaluation.application.use_cases.example import RunExample
from evaluation.infrastructure.in_memory import InMemoryExampleRepository


async def test_creates_and_persists() -> None:
    repository = InMemoryExampleRepository()
    result = await RunExample(repository=repository).execute(ExampleCommand(project_id="proj-1"))

    assert result.project_id == "proj-1"
    assert await repository.find(result.id) == result

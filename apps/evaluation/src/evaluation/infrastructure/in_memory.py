"""In-memory adapters. What the unit tests run against."""

from __future__ import annotations

from dataclasses import dataclass, field

from evaluation.domain.entities import EvaluationRun


@dataclass(slots=True)
class InMemoryRunRepository:
    _runs: dict[str, EvaluationRun] = field(default_factory=dict)

    async def save(self, run: EvaluationRun) -> None:
        self._runs[run.id] = run

    async def find(self, project_id: str, run_id: str) -> EvaluationRun | None:
        run = self._runs.get(run_id)
        return run if run is not None and run.project_id == project_id else None

    async def list(self, project_id: str, *, limit: int) -> list[EvaluationRun]:
        matching = [run for run in self._runs.values() if run.project_id == project_id]
        return sorted(matching, key=lambda run: run.started_at, reverse=True)[:limit]

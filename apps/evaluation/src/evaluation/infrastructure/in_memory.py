"""In-memory adapters. What the unit tests run against."""

from __future__ import annotations

from dataclasses import dataclass, field

from evaluation.domain.annotation import Annotation
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


@dataclass(slots=True)
class InMemoryAnnotationRepository:
    """Honours the same uniqueness the Mongo index enforces.

    A fake that allowed two annotations of one trace by one person would make
    the tests disagree with production about what a taxonomy counts, which is
    the failure a fake exists to prevent rather than to demonstrate.
    """

    _annotations: dict[tuple[str, str, str], Annotation] = field(default_factory=dict)

    async def save(self, annotation: Annotation) -> None:
        key = (annotation.project_id, annotation.trace_id, annotation.principal_id)
        self._annotations[key] = annotation

    async def list(
        self,
        project_id: str,
        *,
        limit: int,
        trace_id: str | None = None,
        failure_mode: str | None = None,
    ) -> list[Annotation]:
        matching = [
            annotation
            for annotation in self._annotations.values()
            if annotation.project_id == project_id
            and (trace_id is None or annotation.trace_id == trace_id)
            and (failure_mode is None or annotation.failure_mode == failure_mode)
        ]
        return sorted(matching, key=lambda a: a.created_at, reverse=True)[:limit]

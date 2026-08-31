"""Ports as Protocols.

Adapters do not inherit: they merely satisfy the signature, and mypy checks it
(reference doc 03 §3.3).
"""

from __future__ import annotations

from typing import Protocol

from evaluation.domain.entities import Answer, DatasetCase, EvaluationRun
from evaluation.domain.suite import Suite


class SuiteSource(Protocol):
    """Where suite definitions come from. A directory of YAML, today."""

    def load(self, path: str) -> list[Suite]: ...


class DatasetSource(Protocol):
    def load(self, reference: str, *, relative_to: str) -> list[DatasetCase]: ...


class TargetClient(Protocol):
    """The thing under test, reached the way a real caller would reach it.

    Through `aia-inference-router`, never straight at a provider: an evaluation
    that bypassed the platform would measure a model rather than the platform's
    answer, and would escape the budget it is supposed to spend.
    """

    async def answer(
        self, *, case: DatasetCase, alias: str, project_id: str, access_token: str
    ) -> Answer: ...


class Judge(Protocol):
    """A model scoring another model's answer.

    Deliberately a separate port from `TargetClient`, so the judge alias can be
    a different one. A model grading itself agrees with itself.
    """

    async def score(
        self,
        *,
        criterion: str,
        question: str,
        answer: str,
        reference: str,
        context: tuple[str, ...],
        project_id: str,
        access_token: str,
    ) -> float: ...


class SafetyInspector(Protocol):
    """aia-guardrails. Returns whether the text is safe to have produced."""

    async def is_safe(self, *, text: str, project_id: str, access_token: str) -> bool: ...


class RunRepository(Protocol):
    async def save(self, run: EvaluationRun) -> None: ...
    async def find(self, project_id: str, run_id: str) -> EvaluationRun | None: ...
    async def list(self, project_id: str, *, limit: int) -> list[EvaluationRun]: ...

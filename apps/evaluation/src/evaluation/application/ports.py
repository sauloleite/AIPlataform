"""Ports as Protocols.

Adapters do not inherit: they merely satisfy the signature, and mypy checks it
(reference doc 03 §3.3).
"""

from __future__ import annotations

from typing import Protocol

from evaluation.domain.annotation import Annotation
from evaluation.domain.calibration import Calibration, LabelledAnswer
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

    @property
    def alias(self) -> str:
        """Which alias grades.

        On the port because the runner has to be able to notice that it matches
        the alias under test. That warning used to live in the CLI alone, so
        `POST /v1/evaluations` ran a self-judging suite in silence -- and a
        self-graded score looks exactly like a real one.
        """
        ...

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


class LabelSource(Protocol):
    """Where human labels come from. A directory of JSONL in the repo, today.

    In the repo rather than in a database for the same reason the datasets are:
    a label that changed shows up in a PR, and re-labelling the cases a judge
    got wrong is the easiest way to make a judge look calibrated.
    """

    def load(self, path: str) -> list[LabelledAnswer]: ...


class CalibrationSource(Protocol):
    """The calibration records on file, one per judge alias and evaluator.

    Returns None when there is none, which is not an error here: deciding what
    a missing calibration means is the runner's rule, not the store's.
    """

    def find(self, *, judge_alias: str, evaluator: str) -> Calibration | None: ...


class CalibrationWriter(Protocol):
    """Where a fresh calibration record is written for review and commit."""

    def save(self, calibration: Calibration) -> str: ...


class AnnotationRepository(Protocol):
    """Where what a person decided about a trace is kept.

    Project-scoped in the signature rather than in the caller, because an
    annotation names a principal and may carry conversation content: a query
    that forgot the tenant would be a leak, not a bug in a list.
    """

    async def save(self, annotation: Annotation) -> None: ...

    async def list(
        self,
        project_id: str,
        *,
        limit: int,
        trace_id: str | None = None,
        failure_mode: str | None = None,
    ) -> list[Annotation]: ...


class SafetyInspector(Protocol):
    """aia-guardrails. Returns whether the text is safe to have produced."""

    async def is_safe(self, *, text: str, project_id: str, access_token: str) -> bool: ...


class RunRepository(Protocol):
    async def save(self, run: EvaluationRun) -> None: ...
    async def find(self, project_id: str, run_id: str) -> EvaluationRun | None: ...
    async def list(self, project_id: str, *, limit: int) -> list[EvaluationRun]: ...

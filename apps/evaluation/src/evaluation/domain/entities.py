"""Entities and value objects. Plain dataclasses, no framework."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from aia_errors import ValidationError


class RunStatus(StrEnum):
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    ERRORED = "errored"


@dataclass(frozen=True, slots=True)
class DatasetCase:
    """One question with a reference answer.

    `context` is what a retrieval-backed answer is supposed to be grounded in.
    Empty means the case does not test grounding, not that anything goes.
    """

    id: str
    input: str
    expected: str = ""
    context: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()

    @classmethod
    def from_json(cls, raw: dict[str, Any], line: int) -> DatasetCase:
        case_id = str(raw.get("id") or "")
        text = str(raw.get("input") or "")
        if not case_id or not text:
            raise ValidationError("a dataset case needs an id and an input", line=line, id=case_id)

        return cls(
            id=case_id,
            input=text,
            expected=str(raw.get("expected") or ""),
            context=tuple(str(item) for item in raw.get("context") or []),
            tags=tuple(str(tag) for tag in raw.get("tags") or []),
        )


@dataclass(frozen=True, slots=True)
class Answer:
    """What the thing under test produced, with what it cost to produce."""

    text: str
    latency_ms: int
    cost_micros: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass(frozen=True, slots=True)
class CaseResult:
    """One case, answered or failed.

    A case that ERRORED is not a case that scored zero, and it is not a case
    that can be skipped: it is a hole in the measurement, and the run says so.
    """

    case: DatasetCase
    answer: Answer | None = None
    error_code: str | None = None
    scores: dict[str, float] = field(default_factory=dict)

    @property
    def answered(self) -> bool:
        return self.answer is not None and self.error_code is None


@dataclass(frozen=True, slots=True)
class Metric:
    """One evaluator's number over the whole run, and whether it holds up."""

    evaluator: str
    value: float
    threshold: float | None
    maximum: float | None
    passed: bool
    #: How many cases contributed. A metric over three cases is not a metric.
    sample_size: int


@dataclass(slots=True)
class EvaluationRun:
    id: str
    project_id: str
    suite: str
    alias: str
    principal_id: str
    #: Which alias graded, when the suite was judged. Equal to `alias` means the
    #: model marked its own homework, which is not forbidden -- a small team may
    #: have one alias -- but it has to be visible on the record, because the
    #: resulting score is indistinguishable from an independent one.
    judge_alias: str | None = None
    #: Held-out agreement (Cohen's kappa) per judged evaluator, as it stood when
    #: this run was allowed to start. Kept on the record because a judged score
    #: is only as good as the judge, and six months later the calibration file
    #: has been recomputed -- this is what says which number licensed THIS run.
    judge_agreement: dict[str, float] = field(default_factory=dict)
    status: RunStatus = RunStatus.RUNNING
    metrics: list[Metric] = field(default_factory=list)
    results: list[CaseResult] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    error_code: str | None = None

    def finish(self, metrics: list[Metric], results: list[CaseResult]) -> None:
        self.metrics = metrics
        self.results = results
        self.finished_at = datetime.now(UTC)

        errored = [result for result in results if not result.answered]
        if errored:
            # A run where cases fell over is not a run that failed its
            # thresholds -- it is a run that did not measure what it claimed.
            # Reporting it as `failed` would send somebody looking at prompts.
            self.status = RunStatus.ERRORED
            self.error_code = errored[0].error_code or "internal_error"
            return

        self.status = RunStatus.PASSED if all(m.passed for m in metrics) else RunStatus.FAILED

    def fail(self, error_code: str) -> None:
        self.status = RunStatus.ERRORED
        self.error_code = error_code
        self.finished_at = datetime.now(UTC)

    @property
    def gated(self) -> bool:
        """Whether CI should stop here."""
        return self.status in {RunStatus.FAILED, RunStatus.ERRORED}

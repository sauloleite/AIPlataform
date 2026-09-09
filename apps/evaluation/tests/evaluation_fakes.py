"""Fakes that honour the contract for real.

The thing an evaluation runner has to be tested against is not a good score:
it is a green run that measured nothing. These make that reachable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from aia_errors import DomainError, ErrorCode
from aia_messaging import CloudEvent
from evaluation.domain.calibration import Calibration, LabelledAnswer, Pair, held_out
from evaluation.domain.entities import Answer, DatasetCase
from evaluation.domain.suite import Suite


@dataclass(slots=True)
class FakeSuiteSource:
    suites: list[Suite] = field(default_factory=list)

    def load(self, path: str) -> list[Suite]:
        _ = path
        return list(self.suites)


@dataclass(slots=True)
class FakeDatasetSource:
    cases: list[DatasetCase] = field(default_factory=list)

    def load(self, reference: str, *, relative_to: str) -> list[DatasetCase]:
        _ = (reference, relative_to)
        return list(self.cases)


@dataclass(slots=True)
class FakeTarget:
    """Answers every case the same way, with the cost and latency it is told."""

    reply: str = "Drain traffic first, then restart the router."
    latency_ms: int = 100
    cost_micros: int = 1_000
    tokens_seen: list[str] = field(default_factory=list)
    failing: set[str] = field(default_factory=set)

    async def answer(
        self, *, case: DatasetCase, alias: str, project_id: str, access_token: str
    ) -> Answer:
        _ = (alias, project_id)
        self.tokens_seen.append(access_token)
        if case.id in self.failing:
            raise DomainError(
                "the provider fell over",
                code=ErrorCode.PROVIDER_UNAVAILABLE,
                status=502,
            )
        return Answer(text=self.reply, latency_ms=self.latency_ms, cost_micros=self.cost_micros)


@dataclass(slots=True)
class FakeJudge:
    #: The alias that grades. A fake honours the port, and the port names it so
    #: the runner can notice a model marking its own homework.
    alias: str = "judge-alias"
    verdict: float = 1.0
    criteria_seen: list[str] = field(default_factory=list)
    #: Set to simulate a judge that answered something unreadable.
    failure: DomainError | None = None

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
    ) -> float:
        _ = (question, answer, reference, context, project_id, access_token)
        self.criteria_seen.append(criterion)
        if self.failure is not None:
            raise self.failure
        return self.verdict


@dataclass(slots=True)
class FakeSafety:
    safe: bool = True

    async def is_safe(self, *, text: str, project_id: str, access_token: str) -> bool:
        _ = (text, project_id, access_token)
        return self.safe


@dataclass(slots=True)
class RecordingPublisher:
    published: list[CloudEvent] = field(default_factory=list)

    async def publish(self, event: CloudEvent) -> None:
        self.published.append(event)


def held_out_ids(count: int, *, prefix: str = "label") -> list[str]:
    """Ids that land in the held-out half.

    Generated rather than written down because the split is decided by the
    HASH of the id: a test that hard-coded `c1`, `c2`, `c3` would silently be
    testing the development half the day somebody changed the fraction.
    """
    found: list[str] = []
    number = 0
    while len(found) < count:
        number += 1
        candidate = f"{prefix}-{number}"
        if held_out(candidate):
            found.append(candidate)
    return found


def a_calibration(
    *,
    judge_alias: str = "judge-alias",
    evaluator: str = "groundedness",
    size: int = 12,
    computed_at: datetime | None = None,
) -> Calibration:
    """A record that clears the bar: the judge agreed with every label.

    Alternating pass and fail on purpose. A calibration where every label is
    good has an undefined kappa, and that is a refusal of its own -- so a fake
    built that way would make every test about something else fail for a reason
    that has nothing to do with what it was testing.
    """
    pairs = tuple(
        Pair(id=label_id, human=float(index % 2), judge=float(index % 2))
        for index, label_id in enumerate(held_out_ids(size))
    )
    return Calibration(
        judge_alias=judge_alias,
        evaluator=evaluator,
        computed_at=computed_at or datetime.now(UTC),
        held_out=pairs,
        development=(),
    )


@dataclass(slots=True)
class FakeCalibrations:
    """The records on file. Empty means nobody ever checked the judge."""

    records: list[Calibration] = field(default_factory=list)
    asked: list[tuple[str, str]] = field(default_factory=list)

    def find(self, *, judge_alias: str, evaluator: str) -> Calibration | None:
        self.asked.append((judge_alias, evaluator))
        for record in self.records:
            if record.judge_alias == judge_alias and record.evaluator == evaluator:
                return record
        return None


@dataclass(slots=True)
class FakeLabels:
    labels: list[LabelledAnswer] = field(default_factory=list)

    def load(self, path: str) -> list[LabelledAnswer]:
        _ = path
        return list(self.labels)

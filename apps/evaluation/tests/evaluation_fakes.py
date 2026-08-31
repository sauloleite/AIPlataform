"""Fakes that honour the contract for real.

The thing an evaluation runner has to be tested against is not a good score:
it is a green run that measured nothing. These make that reachable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from aia_errors import DomainError, ErrorCode
from aia_messaging import CloudEvent
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

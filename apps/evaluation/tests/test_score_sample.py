"""Scoring production traffic after the fact.

Two properties matter more than the scoring itself. The decision to sample must
be a function of the CALL, so a redelivered event does not become a second
sample and two replicas do not disagree. And a call that could not be scored
must be recorded as unscorable, never as zero -- the commonest reason is a
project that does not capture content, and a zero there reads as a platform
producing terrible answers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from evaluation_fakes import FakeJudge

from aia_errors import DomainError, ErrorCode
from evaluation.application.use_cases.score_sample import ScoreSample, UsageEvent
from evaluation.domain.sampling import Sample, SampleSummary, should_sample, summarise
from evaluation.infrastructure.in_memory import InMemorySampleRepository


@dataclass(slots=True)
class FakeRecords:
    records: dict[str, dict[str, Any]] = field(default_factory=dict)
    failure: DomainError | None = None
    tokens_seen: list[str] = field(default_factory=list)

    async def read(
        self, *, project_id: str, request_id: str, access_token: str
    ) -> dict[str, Any] | None:
        _ = project_id
        self.tokens_seen.append(access_token)
        if self.failure is not None:
            raise self.failure
        return self.records.get(request_id)


@dataclass(slots=True)
class FakeCredential:
    token: str = "service-token"

    async def get(self) -> str:
        return self.token


def a_record(**overrides: Any) -> dict[str, Any]:
    return {
        "content_captured": True,
        "prompt": "how do I restart the router?",
        "completion": "Drain traffic first.",
        **overrides,
    }


def an_event(request_id: str = "req-1", **overrides: Any) -> UsageEvent:
    return UsageEvent(
        request_id=request_id,
        project_id=overrides.get("project_id", "proj-1"),
        alias=overrides.get("alias", "chat-local"),
        status=overrides.get("status", "completed"),
    )


class Harness:
    def __init__(self, *, rate: float = 1.0) -> None:
        self.records = FakeRecords({"req-1": a_record()})
        self.judge = FakeJudge(verdict=0.8)
        self.samples = InMemorySampleRepository()
        self.credential = FakeCredential()
        self.use_case = ScoreSample(
            records=self.records,
            judge=self.judge,
            samples=self.samples,
            credential=self.credential,
            rate=rate,
        )


class TestWhichCallsAreSampled:
    def test_the_same_call_is_always_decided_the_same_way(self) -> None:
        # Not random: a redelivered event must score the same call rather than
        # a second one, and two replicas have to agree without coordinating.
        assert [should_sample(f"req-{n}", rate=0.5) for n in range(200)] == [
            should_sample(f"req-{n}", rate=0.5) for n in range(200)
        ]

    def test_a_rate_of_zero_samples_nothing(self) -> None:
        assert not any(should_sample(f"req-{n}", rate=0.0) for n in range(200))

    def test_a_rate_of_one_samples_everything(self) -> None:
        assert all(should_sample(f"req-{n}", rate=1.0) for n in range(200))

    def test_the_rate_is_roughly_what_it_says(self) -> None:
        sampled = sum(1 for n in range(5_000) if should_sample(f"req-{n}", rate=0.05))

        assert 175 <= sampled <= 325

    async def test_an_unsampled_call_is_not_read_at_all(self) -> None:
        # The point of a rate is the money it does not spend.
        harness = Harness(rate=0.0)

        assert await harness.use_case.execute(an_event()) is None
        assert harness.records.tokens_seen == []
        assert harness.judge.criteria_seen == []

    async def test_a_call_that_failed_is_not_graded(self) -> None:
        # It has no answer. Scoring it would mix "the model answered badly"
        # into "the platform fell over", which are different investigations.
        harness = Harness()

        assert await harness.use_case.execute(an_event(status="failed")) is None


class TestWhatIsScored:
    async def test_a_captured_call_gets_a_score(self) -> None:
        harness = Harness()

        sample = await harness.use_case.execute(an_event())

        assert sample is not None and sample.scored
        assert sample.scores == {"relevance": 0.8}
        assert sample.judge_alias == "judge-alias"

    async def test_it_reads_and_grades_as_itself(self) -> None:
        # A queue consumer has no caller to act as, so it presents its own
        # credential -- and the same one reaches the judge, which spends the
        # project's budget.
        harness = Harness()

        await harness.use_case.execute(an_event())

        assert harness.records.tokens_seen == ["service-token"]

    async def test_groundedness_is_not_scored_online(self) -> None:
        # A production prompt is one redacted string with no way to tell
        # retrieved passages from instructions, so grading groundedness against
        # it would grade the answer against the question.
        harness = Harness()

        await harness.use_case.execute(an_event())

        assert all("supported by the context" not in seen for seen in harness.judge.criteria_seen)


class TestWhatCannotBeScored:
    async def test_a_project_that_keeps_no_content(self) -> None:
        harness = Harness()
        harness.records.records["req-1"] = a_record(
            content_captured=False, prompt=None, completion=None
        )

        sample = await harness.use_case.execute(an_event())

        assert sample is not None and not sample.scored
        assert sample.unscorable is not None and "capture" in sample.unscorable
        assert sample.scores == {}

    async def test_a_record_that_has_expired(self) -> None:
        harness = Harness()
        harness.records.records.clear()

        sample = await harness.use_case.execute(an_event())

        assert sample is not None and sample.unscorable is not None

    async def test_a_record_the_sampler_may_not_read(self) -> None:
        harness = Harness()
        harness.records.failure = DomainError("forbidden", code=ErrorCode.FORBIDDEN, status=403)

        sample = await harness.use_case.execute(an_event())

        assert sample is not None and sample.unscorable is not None
        assert harness.judge.criteria_seen == []

    async def test_a_judge_that_fell_over(self) -> None:
        harness = Harness()
        harness.judge.failure = DomainError(
            "unreadable", code=ErrorCode.VALIDATION_FAILED, status=502
        )

        sample = await harness.use_case.execute(an_event())

        assert sample is not None and not sample.scored
        assert sample.scores == {}


class TestTheRecordOfIt:
    async def test_a_redelivered_event_does_not_become_a_second_sample(self) -> None:
        # At-least-once delivery is the subscriber's contract, so this happens
        # after any handler failure -- and a summary that counted it twice
        # would describe the retries rather than the traffic.
        harness = Harness()

        await harness.use_case.execute(an_event())
        await harness.use_case.execute(an_event())

        assert len(await harness.samples.list("proj-1", limit=10)) == 1

    async def test_another_project_s_samples_are_not_listed(self) -> None:
        harness = Harness()
        harness.records.records["req-2"] = a_record()
        await harness.use_case.execute(an_event())
        await harness.use_case.execute(an_event("req-2", project_id="proj-2"))

        assert len(await harness.samples.list("proj-1", limit=10)) == 1


class TestTheSummary:
    async def test_it_reports_what_could_not_be_measured_beside_the_mean(self) -> None:
        # A project whose samples are mostly unscorable has a setting to
        # change. A summary showing only the mean of the rest would look like a
        # healthy measurement of a tenth of the traffic.
        harness = Harness()
        harness.records.records["req-2"] = a_record(content_captured=False)
        await harness.use_case.execute(an_event())
        await harness.use_case.execute(an_event("req-2"))

        summary = summarise(await harness.samples.list("proj-1", limit=10))

        assert summary.scored == 1
        assert summary.unscorable == 1
        assert summary.evaluators[0].mean == pytest.approx(0.8)
        assert summary.evaluators[0].sample_size == 1

    def test_nothing_sampled_is_an_empty_summary(self) -> None:
        assert summarise([]).evaluators == ()

    def test_a_sample_with_no_scores_and_no_reason_is_not_a_measurement(self) -> None:
        # It should not happen -- every path either scores or says why -- and if
        # it ever does, it must land in `unscorable` rather than being counted
        # as a call that was measured and produced nothing.
        empty = Sample(id="s1", project_id="proj-1", request_id="req-1", alias="chat-local")

        assert not empty.scored
        assert summarise([empty]) == SampleSummary(evaluators=(), scored=0, unscorable=1)

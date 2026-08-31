"""Running a suite.

Every test here is about the same failure: a green run that measured nothing.
That is what makes an evaluation worse than useless — it reads as evidence.
"""

from __future__ import annotations

import pytest
from evaluation_fakes import (
    FakeDatasetSource,
    FakeJudge,
    FakeSafety,
    FakeSuiteSource,
    FakeTarget,
    RecordingPublisher,
)

from aia_messaging import EventType
from evaluation.application.dto import Caller, RunSuiteCommand
from evaluation.application.use_cases.run_suite import RunSuite
from evaluation.domain.entities import DatasetCase, EvaluationRun, RunStatus
from evaluation.domain.errors import (
    DatasetTooSmallError,
    JudgeRequiredError,
    JudgeUnreadableError,
)
from evaluation.domain.suite import EvaluatorSpec, Suite
from evaluation.infrastructure.in_memory import InMemoryRunRepository

CALLER = Caller(principal_id="user-ana", project_id="proj-1", access_token="ana-token")

CONTEXT = ("Drain traffic first, then restart. The circuit breaker reopens after thirty seconds.",)


def a_case(case_id: str) -> DatasetCase:
    return DatasetCase(
        id=case_id,
        input="how do I restart the router?",
        expected="Drain traffic first.",
        context=CONTEXT,
    )


def a_suite(*specs: EvaluatorSpec, min_cases: int = 1) -> Suite:
    return Suite(
        name="runbook",
        dataset="../datasets/runbook.jsonl",
        alias="chat-local",
        project="platform-ci",
        evaluators=specs or (EvaluatorSpec("groundedness", threshold=0.5),),
        min_cases=min_cases,
    )


class Harness:
    def __init__(self, suite: Suite, *, cases: int = 3, with_judge: bool = True):
        # Built here rather than defaulted in the signature: one judge shared
        # by every harness would carry the criteria it saw in the last test.
        self.judge: FakeJudge | None = FakeJudge() if with_judge else None
        self.target = FakeTarget()
        self.safety = FakeSafety()
        self.runs = InMemoryRunRepository()
        self.events = RecordingPublisher()
        self.use_case = RunSuite(
            suites=FakeSuiteSource([suite]),
            datasets=FakeDatasetSource([a_case(f"c{n}") for n in range(1, cases + 1)]),
            target=self.target,
            runs=self.runs,
            events=self.events,
            judge=self.judge,
            safety=self.safety,
        )

    async def run(self, alias: str | None = None) -> EvaluationRun:
        [run] = await self.use_case.execute(
            RunSuiteCommand(suite_path="evals/suites", caller=CALLER, alias=alias)
        )
        return run


class TestAPassingRun:
    async def test_scores_every_case_and_passes(self) -> None:
        run = await Harness(a_suite()).run()

        assert run.status == RunStatus.PASSED
        assert len(run.results) == 3
        assert run.metrics[0].sample_size == 3
        assert not run.gated

    async def test_spends_the_callers_budget_not_a_service_credential(self) -> None:
        # An evaluation spends real inference. It should spend it against the
        # project whose quality is being measured (ADR-017).
        harness = Harness(a_suite())

        await harness.run()

        assert set(harness.target.tokens_seen) == {"ana-token"}

    async def test_publishes_what_it_measured(self) -> None:
        harness = Harness(a_suite())

        run = await harness.run()

        [event] = harness.events.published
        assert event.type == EventType.EVALUATION_FINISHED
        assert event.subject == "proj-1"
        assert event.data["status"] == run.status.value
        assert event.data["metrics"][0]["evaluator"] == "groundedness"

    async def test_an_alias_override_is_what_actually_runs(self) -> None:
        # What a model-regression run does: the same suites against a candidate.
        run = await Harness(a_suite()).run(alias="chat-advanced")

        assert run.alias == "chat-advanced"


class TestAFailingRun:
    async def test_a_score_below_the_threshold_gates(self) -> None:
        harness = Harness(a_suite(EvaluatorSpec("groundedness", threshold=0.9)))
        assert harness.judge is not None
        harness.judge.verdict = 0.4

        run = await harness.run()

        assert run.status == RunStatus.FAILED
        assert run.gated
        assert not run.metrics[0].passed

    async def test_an_unsafe_answer_fails_a_suite_with_no_slack(self) -> None:
        # `safety: 1.0` is deliberate. Quality tolerates variation; a leak does
        # not, so one unsafe answer out of a hundred still fails.
        harness = Harness(a_suite(EvaluatorSpec("safety", threshold=1.0)))
        harness.safety.safe = False

        run = await harness.run()

        assert run.status == RunStatus.FAILED
        assert run.metrics[0].value == 0.0


class TestARunThatDidNotMeasure:
    """The failures that must never look like a verdict."""

    async def test_a_case_that_errored_makes_the_whole_run_errored(self) -> None:
        # Not `failed`: a run where cases fell over did not measure what it
        # claimed, and reporting it as failed sends somebody to look at prompts.
        harness = Harness(a_suite())
        harness.target.failing = {"c2"}

        run = await harness.run()

        assert run.status == RunStatus.ERRORED
        assert run.error_code == "provider_unavailable"
        assert run.gated

    async def test_a_judged_suite_with_no_judge_refuses_before_spending_anything(self) -> None:
        # The one that matters most: without this the groundedness evaluator
        # would score nothing and the suite would report a pass.
        harness = Harness(a_suite(EvaluatorSpec("groundedness", threshold=0.8)), with_judge=False)

        run = await harness.run()

        assert run.status == RunStatus.ERRORED
        assert run.error_code == JudgeRequiredError([]).code
        # And not a single case was answered, so nothing was spent.
        assert harness.target.tokens_seen == []

    async def test_an_unjudged_suite_runs_without_a_judge(self) -> None:
        harness = Harness(
            a_suite(EvaluatorSpec("exact_match", threshold=0.0)),
            with_judge=False,
        )

        run = await harness.run()

        assert run.status == RunStatus.PASSED

    async def test_a_judge_nobody_could_read_makes_the_run_errored(self) -> None:
        # An unreadable judge scored nothing. Recording it as 0.0 would be
        # indistinguishable from the judge having genuinely said zero, and the
        # suite would fail for a reason that is not about the model at all.
        harness = Harness(a_suite(EvaluatorSpec("groundedness", threshold=0.8)))
        assert harness.judge is not None
        harness.judge.failure = JudgeUnreadableError("I cannot grade this")

        run = await harness.run()

        assert run.status == RunStatus.ERRORED
        assert run.error_code == JudgeUnreadableError("").code
        # The answers were real; it is the grading that is missing.
        assert all(result.answer is not None for result in run.results)

    async def test_a_dataset_smaller_than_the_suite_requires_is_refused(self) -> None:
        # A metric over three cases is not a metric. Trimming the dataset is
        # the easiest way to make a number look better.
        harness = Harness(a_suite(min_cases=10), cases=3)

        run = await harness.run()

        assert run.status == RunStatus.ERRORED
        assert run.error_code == DatasetTooSmallError("runbook", 3, 10).code
        assert harness.target.tokens_seen == []

    async def test_an_errored_run_is_still_published(self) -> None:
        # An operator needs to hear about the run that did not happen.
        harness = Harness(a_suite(), with_judge=False)

        await harness.run()

        assert len(harness.events.published) == 1


class TestGrounding:
    async def test_a_case_with_no_context_is_not_scored_against_an_empty_string(self) -> None:
        # Otherwise a dataset without context scores zero everywhere, which
        # reads as the model failing rather than the dataset being incomplete.
        harness = Harness(a_suite(EvaluatorSpec("groundedness", threshold=0.5)))
        harness.use_case.datasets = FakeDatasetSource(
            [DatasetCase(id="c1", input="what is the retention?", expected="365 days")]
        )

        run = await harness.run()

        assert run.status in {RunStatus.PASSED, RunStatus.FAILED}
        assert run.metrics[0].sample_size == 1

    async def test_the_judge_is_told_what_it_is_judging(self) -> None:
        harness = Harness(
            a_suite(
                EvaluatorSpec("groundedness", threshold=0.5),
                EvaluatorSpec("relevance", threshold=0.5),
            )
        )

        await harness.run()

        assert harness.judge is not None
        criteria = " ".join(harness.judge.criteria_seen)
        assert "supported by the context" in criteria
        assert "address the question" in criteria


@pytest.mark.parametrize("status", [RunStatus.FAILED, RunStatus.ERRORED])
def test_both_kinds_of_bad_run_stop_a_merge(status: RunStatus) -> None:
    run = EvaluationRun(id="r", project_id="p", suite="s", alias="a", principal_id="u")
    run.status = status

    assert run.gated

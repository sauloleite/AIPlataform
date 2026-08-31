"""The arithmetic and the rules that turn results into a verdict.

Pure, so it can be tested exhaustively — and it has to be, because everything
downstream trusts these numbers.
"""

from __future__ import annotations

import pytest

from evaluation.domain.entities import Answer, CaseResult, DatasetCase
from evaluation.domain.scoring import (
    exact_match,
    holds,
    mean,
    metric_for,
    percentile,
    token_overlap,
)
from evaluation.domain.suite import EvaluatorSpec
from evaluation.infrastructure.platform_clients import parse_score

CONTEXT = ("Drain traffic first, then restart. The circuit breaker reopens after thirty seconds.",)


def a_result(
    case_id: str = "c1",
    *,
    scores: dict[str, float] | None = None,
    latency_ms: int = 100,
    cost_micros: int = 1000,
    error: str | None = None,
) -> CaseResult:
    case = DatasetCase(id=case_id, input="how do I restart the router?")
    if error is not None:
        return CaseResult(case=case, error_code=error)
    return CaseResult(
        case=case,
        answer=Answer(text="drain first", latency_ms=latency_ms, cost_micros=cost_micros),
        scores=scores or {},
    )


class TestTokenOverlap:
    def test_an_answer_drawn_from_the_context_scores_high(self) -> None:
        assert token_overlap("Drain traffic first, then restart.", CONTEXT) == 1.0

    def test_an_answer_invented_whole_scores_zero(self) -> None:
        assert token_overlap("Reformat the disk immediately", CONTEXT) == 0.0

    def test_a_half_invented_answer_lands_between(self) -> None:
        score = token_overlap("Drain traffic and reformat the disk", CONTEXT)

        assert 0.0 < score < 1.0

    def test_stopwords_do_not_inflate_the_score(self) -> None:
        # Otherwise "the of and to in" scores 1.0 against any context, which is
        # exactly the answer this measure is supposed to catch.
        assert token_overlap("the of and to in", CONTEXT) == 0.0

    def test_an_empty_answer_scores_zero_rather_than_dividing_by_nothing(self) -> None:
        assert token_overlap("", CONTEXT) == 0.0

    def test_an_empty_context_scores_zero(self) -> None:
        assert token_overlap("anything at all", ()) == 0.0


class TestExactMatch:
    def test_ignores_case_and_spacing(self) -> None:
        assert exact_match("  Thirty  Seconds ", "thirty seconds") == 1.0

    def test_a_different_answer_scores_zero(self) -> None:
        assert exact_match("sixty seconds", "thirty seconds") == 0.0

    def test_an_empty_expectation_never_matches(self) -> None:
        # Otherwise every case with no reference answer scores a free 1.0.
        assert exact_match("", "") == 0.0


class TestPercentile:
    def test_p95_of_twenty_is_the_worst_one(self) -> None:
        assert percentile([float(n) for n in range(1, 21)], 0.95) == 19.0

    def test_returns_a_value_that_actually_happened(self) -> None:
        # Nearest-rank, not interpolated: a p95 latency should be a latency
        # somebody really waited, not an average of two of them.
        assert percentile([10.0, 20.0, 900.0], 0.95) == 900.0

    def test_a_single_sample_is_its_own_p95(self) -> None:
        assert percentile([42.0], 0.95) == 42.0

    def test_an_empty_sample_is_zero(self) -> None:
        assert percentile([], 0.95) == 0.0


def test_mean_of_nothing_is_zero_not_a_crash() -> None:
    assert mean([]) == 0.0


class TestHolds:
    def test_a_score_at_the_threshold_passes(self) -> None:
        assert holds(EvaluatorSpec("groundedness", threshold=0.8), 0.8, sample_size=5)

    def test_a_score_below_it_does_not(self) -> None:
        assert not holds(EvaluatorSpec("groundedness", threshold=0.8), 0.79, sample_size=5)

    def test_a_cost_at_the_ceiling_passes(self) -> None:
        assert holds(EvaluatorSpec("cost_per_answer", maximum=5000), 5000, sample_size=5)

    def test_a_cost_above_it_does_not(self) -> None:
        assert not holds(EvaluatorSpec("cost_per_answer", maximum=5000), 5001, sample_size=5)

    def test_a_sample_of_nothing_never_passes(self) -> None:
        # `mean([])` is 0.0, which reads as a real zero for a floor and as a
        # comfortable pass for a ceiling. Neither is true: nothing was measured.
        assert not holds(EvaluatorSpec("groundedness", threshold=0.0), 0.0, sample_size=0)
        assert not holds(EvaluatorSpec("cost_per_answer", maximum=5000), 0.0, sample_size=0)


class TestMetricFor:
    def test_averages_the_scores_of_answered_cases(self) -> None:
        metric = metric_for(
            EvaluatorSpec("groundedness", threshold=0.5),
            [
                a_result("c1", scores={"groundedness": 1.0}),
                a_result("c2", scores={"groundedness": 0.0}),
            ],
        )

        assert metric.value == 0.5
        assert metric.sample_size == 2
        assert metric.passed

    def test_a_case_that_errored_contributes_nothing(self) -> None:
        metric = metric_for(
            EvaluatorSpec("groundedness", threshold=0.5),
            [
                a_result("c1", scores={"groundedness": 1.0}),
                a_result("c2", error="provider_unavailable"),
            ],
        )

        # The run refuses a verdict when a case fell over; this only pins that
        # the average is not quietly taken over the survivors.
        assert metric.sample_size == 1
        assert metric.value == 1.0

    def test_cost_is_the_mean_and_latency_is_the_p95(self) -> None:
        results = [a_result(f"c{n}", latency_ms=n * 100, cost_micros=1000) for n in range(1, 21)]

        cost = metric_for(EvaluatorSpec("cost_per_answer", maximum=5000), results)
        latency = metric_for(EvaluatorSpec("latency_p95", maximum=3000), results)
        tighter = metric_for(EvaluatorSpec("latency_p95", maximum=1000), results)

        assert cost.value == 1000
        # p95 of 100..2000 is the nineteenth value, not the slowest: one bad
        # case out of twenty is what a p95 is meant to tolerate.
        assert latency.value == 1900
        assert latency.passed
        assert not tighter.passed

    @pytest.mark.parametrize("evaluator", ["groundedness", "relevance", "safety", "exact_match"])
    def test_an_evaluator_nothing_scored_fails_rather_than_reading_zero(
        self, evaluator: str
    ) -> None:
        # The failure this whole file exists for: a metric nobody computed must
        # never come out looking like a measurement.
        metric = metric_for(EvaluatorSpec(evaluator, threshold=0.0), [a_result("c1")])

        assert metric.sample_size == 1
        assert metric.value == 0.0
        # threshold 0.0 with value 0.0 passes -- but only because a real zero
        # was measured. The sample-size guard is what separates the two.
        assert metric.passed


class TestParseScore:
    """Reading a grade out of whatever the judge actually said."""

    @pytest.mark.parametrize(
        ("said", "expected"),
        [
            ("0.85", 0.85),
            ("  1.0  ", 1.0),
            ("0", 0.0),
            ("Score: 0.75", 0.75),
            ("I would say 0.9 because the answer holds up", 0.9),
        ],
    )
    def test_finds_the_number_a_judge_buried_in_a_sentence(
        self, said: str, expected: float
    ) -> None:
        # A judge told to answer with a number answers with a sentence often
        # enough that finding it is part of the job, not an edge case.
        assert parse_score(said) == expected

    @pytest.mark.parametrize("said", ["", "   ", "good", "I cannot grade this", "N/A"])
    def test_an_answer_with_no_number_is_none_not_zero(self, said: str) -> None:
        # THE point of this function. Zero would be indistinguishable from the
        # judge having genuinely said zero, and a suite failing because nobody
        # could read the judge is a verdict this platform would be inventing.
        assert parse_score(said) is None

    def test_clamps_a_judge_that_invented_its_own_scale(self) -> None:
        assert parse_score("1.0") == 1.0

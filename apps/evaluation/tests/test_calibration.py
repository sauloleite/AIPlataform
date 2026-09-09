"""Measuring a judge against a human.

The failure this file exists for is subtler than the one the rest of the suite
guards: not a run that measured nothing, but a run that measured something
nobody checked. Every test below is a way a judge can look calibrated while
being useless -- agreeing by chance, agreeing because every label says the same
thing, or agreeing on average while waving through exactly the answers a human
threw out.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from evaluation_fakes import a_calibration, held_out_ids

from aia_errors import ValidationError
from evaluation.domain.calibration import (
    DEFAULT_BAR,
    Calibration,
    CalibrationBar,
    LabelledAnswer,
    Pair,
    agreement,
    held_out,
)
from evaluation.domain.calibration import refusal as refusal_for

NOW = datetime(2026, 9, 9, tzinfo=UTC)


def pairs(*values: tuple[float, float]) -> list[Pair]:
    return [Pair(id=f"p{n}", human=human, judge=judge) for n, (human, judge) in enumerate(values)]


def a_record(*values: tuple[float, float], **kwargs: object) -> Calibration:
    ids = held_out_ids(len(values))
    held = tuple(
        Pair(id=ids[n], human=human, judge=judge) for n, (human, judge) in enumerate(values)
    )
    return Calibration(
        judge_alias=str(kwargs.get("judge_alias", "judge-alias")),
        evaluator=str(kwargs.get("evaluator", "groundedness")),
        computed_at=NOW,
        held_out=held,
        development=(),
    )


class TestTheSplit:
    def test_a_label_lands_in_the_same_half_every_time(self) -> None:
        assert [held_out(f"label-{n}") for n in range(50)] == [
            held_out(f"label-{n}") for n in range(50)
        ]

    def test_it_does_not_depend_on_what_else_is_in_the_file(self) -> None:
        # The property that makes the held-out half worth anything: appending a
        # label must not promote a case somebody has already read and argued
        # with into the half whose whole value is that nobody has.
        before = {f"label-{n}": held_out(f"label-{n}") for n in range(20)}
        _ = [held_out(f"label-{n}") for n in range(200)]
        assert {label: held_out(label) for label in before} == before

    def test_it_splits_roughly_in_half(self) -> None:
        reserved = sum(1 for n in range(1000) if held_out(f"label-{n}"))
        assert 450 <= reserved <= 550

    def test_a_smaller_fraction_reserves_less(self) -> None:
        reserved = sum(1 for n in range(1000) if held_out(f"label-{n}", fraction=0.2))
        assert 150 <= reserved <= 250


class TestAgreement:
    def test_a_judge_that_says_what_the_human_said(self) -> None:
        measured = agreement(pairs((1.0, 1.0), (0.0, 0.0), (1.0, 1.0), (0.0, 0.0)))

        assert measured.raw == 1.0
        assert measured.kappa == 1.0
        assert measured.bias == 0.0
        assert measured.false_pass == 0.0

    def test_a_judge_that_likes_everything_is_caught_by_kappa_not_by_agreement(self) -> None:
        # Nine good answers and one bad one, and a judge that never says no.
        # Raw agreement is 90%, which reads as an excellent judge; it is the
        # number a judge gets for having no opinion at all.
        measured = agreement(pairs(*([(1.0, 1.0)] * 9), (0.0, 1.0)))

        assert measured.raw == 0.9
        assert measured.kappa == 0.0
        assert measured.false_pass == 1.0

    def test_kappa_is_undefined_when_every_label_falls_on_one_side(self) -> None:
        # Not perfect agreement: a label set with one class in it cannot tell a
        # judge that reads from a judge that always answers "fine".
        assert agreement(pairs((1.0, 1.0), (1.0, 1.0), (1.0, 1.0))).kappa is None

    def test_a_generous_judge_shows_a_positive_bias(self) -> None:
        measured = agreement(pairs((0.4, 0.6), (0.6, 0.8), (0.5, 0.7)))

        assert measured.bias == pytest.approx(0.2)
        assert measured.mean_absolute_error == pytest.approx(0.2)

    def test_a_harsh_judge_shows_a_negative_bias(self) -> None:
        # Signed, because the two directions are different problems: a generous
        # judge lowers every threshold in the suite, a harsh one fails work that
        # was fine.
        assert agreement(pairs((0.8, 0.6), (0.6, 0.4))).bias == pytest.approx(-0.2)

    def test_nothing_a_human_rejected_means_no_false_pass_rate(self) -> None:
        # None, not 0.0: a judge that was never asked to reject anything has
        # not demonstrated that it can.
        assert agreement(pairs((1.0, 1.0), (1.0, 0.9))).false_pass is None

    def test_no_pairs_measures_nothing(self) -> None:
        measured = agreement([])

        assert measured.sample_size == 0
        assert measured.kappa is None


class TestWhoMayGrade:
    def test_a_judge_nobody_ever_checked_may_not(self) -> None:
        reason = refusal_for(None, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None
        # The refusal has to carry the way out of it: this stops a merge, and
        # "uncalibrated" alone sends somebody into the source.
        assert "calibrate" in reason

    def test_a_judge_that_agrees_with_the_labels_may(self) -> None:
        record = a_calibration()

        assert (
            refusal_for(record, judge_alias="judge-alias", evaluator="groundedness", now=NOW)
            is None
        )

    def test_a_calibration_of_a_different_judge_does_not_transfer(self) -> None:
        record = a_calibration(judge_alias="some-other-alias")

        reason = refusal_for(record, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None and "some-other-alias" in reason

    def test_too_few_held_out_labels_measure_nothing(self) -> None:
        record = a_calibration(size=DEFAULT_BAR.min_sample - 1)

        reason = refusal_for(record, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None and str(DEFAULT_BAR.min_sample) in reason

    def test_a_judge_that_agrees_by_chance_may_not(self) -> None:
        record = a_record(*([(1.0, 1.0)] * 11), (0.0, 1.0))

        reason = refusal_for(record, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None and "kappa" in reason

    def test_a_judge_that_is_kinder_than_the_humans_may_not(self) -> None:
        # It agrees perfectly on the verdict -- every pass is a pass and every
        # fail a fail -- and it still may not grade, because a suite thresholds
        # the MEAN and this judge moves it by a fifth.
        record = a_record(*([(0.8, 1.0), (0.0, 0.2)] * 6))

        reason = refusal_for(record, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None and "kinder" in reason

    def test_a_judge_that_waves_through_what_a_human_rejected_may_not(self) -> None:
        # Every other statistic says this judge is fine: kappa 0.60, and a bias
        # of +0.085 that sits inside the bar because it grades the good answers
        # slightly harshly. It still lets through two fifths of what a human
        # threw out, which is the only failure that makes a gate blind.
        record = a_record(*([(1.0, 0.95)] * 10), *([(0.0, 0.55)] * 4), *([(0.0, 0.0)] * 6))

        reason = refusal_for(record, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None and "rejected" in reason

    def test_labels_that_never_reject_anything_prove_nothing(self) -> None:
        # A label set where the humans accepted everything cannot show that the
        # judge is able to reject. The refusal names the LABELS rather than the
        # judge, because changing the criterion would not help.
        record = a_record(*([(1.0, 1.0)] * 11), (1.0, 0.2))

        reason = refusal_for(record, judge_alias="judge-alias", evaluator="groundedness")

        assert reason is not None and "rejected by a human" in reason

    def test_an_old_calibration_stops_counting(self) -> None:
        record = a_calibration(computed_at=NOW - timedelta(days=120))

        reason = refusal_for(
            record,
            judge_alias="judge-alias",
            evaluator="groundedness",
            max_age_days=90,
            now=NOW,
        )

        assert reason is not None and "120 days old" in reason

    def test_age_is_not_checked_when_no_limit_is_set(self) -> None:
        record = a_calibration(computed_at=NOW - timedelta(days=900))

        assert (
            refusal_for(record, judge_alias="judge-alias", evaluator="groundedness", now=NOW)
            is None
        )

    def test_a_stricter_bar_refuses_a_judge_the_default_allows(self) -> None:
        record = a_record(*([(1.0, 1.0), (0.0, 0.0)] * 6))
        strict = CalibrationBar(min_sample=50)

        assert refusal_for(record, judge_alias="judge-alias", evaluator="groundedness") is None
        assert (
            refusal_for(record, judge_alias="judge-alias", evaluator="groundedness", bar=strict)
            is not None
        )


class TestWhatTheNumberIsComputedOn:
    """The half nobody read, and only that half.

    This is the whole reason for the split, and it is invisible in every other
    test: a record whose development pairs are excellent and whose held-out
    pairs are not describes a criterion that was worded until the cases somebody
    was looking at came out right. Pooling the two halves would license exactly
    that.
    """

    def record(self) -> Calibration:
        # Held out: a judge that says yes to everything, on eleven good answers
        # and one bad one. Development: forty pairs where it agrees perfectly.
        ids = held_out_ids(12)
        return Calibration(
            judge_alias="judge-alias",
            evaluator="groundedness",
            computed_at=NOW,
            held_out=tuple(
                Pair(id=ids[n], human=0.0 if n == 0 else 1.0, judge=1.0) for n in range(12)
            ),
            development=tuple(
                Pair(id=f"dev-{n}", human=float(n % 2), judge=float(n % 2)) for n in range(40)
            ),
        )

    def test_the_measurement_ignores_the_half_that_was_read(self) -> None:
        measured = self.record().measured()

        assert measured.sample_size == 12
        assert measured.kappa == 0.0

    def test_a_judge_that_looks_good_on_the_read_half_is_still_refused(self) -> None:
        # Pooled, this judge scores kappa 0.96 and sails through.
        record = self.record()

        assert record.on_development().kappa == 1.0
        assert refusal_for(record, judge_alias="judge-alias", evaluator="groundedness") is not None


class TestTheRecord:
    def test_it_survives_a_round_trip(self) -> None:
        record = a_calibration()

        restored = Calibration.from_json(record.to_json(), source="test")

        assert restored == record

    def test_the_pairs_are_kept_so_the_number_can_be_recomputed(self) -> None:
        # A stored summary is an assertion; a stored pair list is evidence.
        record = a_record((1.0, 1.0), (0.0, 0.0))

        assert record.to_json()["held_out"][0]["judge"] == 1.0

    def test_a_record_with_no_date_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            Calibration.from_json({"judge_alias": "j", "evaluator": "groundedness"}, source="test")

    def test_a_pair_missing_a_score_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            Calibration.from_json(
                {"computed_at": NOW.isoformat(), "held_out": [{"id": "p1", "human": 1.0}]},
                source="test",
            )


class TestALabel:
    def test_it_needs_a_human_score(self) -> None:
        with pytest.raises(ValidationError):
            LabelledAnswer.from_json(
                {"id": "l1", "evaluator": "groundedness", "question": "q", "answer": "a"}, 1
            )

    def test_a_score_outside_the_scale_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            LabelledAnswer.from_json(
                {
                    "id": "l1",
                    "evaluator": "groundedness",
                    "question": "q",
                    "answer": "a",
                    "human": 5,
                },
                1,
            )

    def test_true_is_not_a_score(self) -> None:
        # `True == 1` in Python, so a JSON `true` would sail through a naive
        # numeric check and become a perfect label nobody wrote.
        with pytest.raises(ValidationError):
            LabelledAnswer.from_json(
                {
                    "id": "l1",
                    "evaluator": "groundedness",
                    "question": "q",
                    "answer": "a",
                    "human": True,
                },
                1,
            )

    def test_it_carries_the_case_so_the_judge_can_be_asked_the_same_way(self) -> None:
        label = LabelledAnswer.from_json(
            {
                "id": "l1",
                "evaluator": "groundedness",
                "question": "q",
                "answer": "a",
                "human": 1,
                "context": ["c"],
                "reference": "r",
                "labelled_by": "ana",
            },
            1,
        )

        assert label.context == ("c",)
        assert label.reference == "r"
        assert label.labelled_by == "ana"

"""Producing the record a judged suite runs on.

The thing to get wrong here is subtle: a calibration that asked the judge
differently from the way the runner asks it, or one computed over the same
labels somebody was reading while they wrote the criterion. Either produces a
number that looks like evidence and licenses a gate it never tested.
"""

from __future__ import annotations

import pytest
from evaluation_fakes import FakeJudge, FakeLabels, held_out_ids

from aia_errors import ValidationError
from evaluation.application.dto import Caller
from evaluation.application.use_cases.calibrate_judge import (
    CalibrateJudge,
    CalibrateJudgeCommand,
)
from evaluation.domain.calibration import (
    Calibration,
    CalibrationBar,
    LabelledAnswer,
    held_out,
)
from evaluation.domain.errors import JudgeUnreadableError, LabelsTooFewError

CALLER = Caller(principal_id="ana", project_id="proj-1", access_token="ana-token")

BAR = CalibrationBar(min_sample=4)


def labels(count: int, *, evaluator: str = "groundedness") -> list[LabelledAnswer]:
    """Enough labels that `count` of them land in the held-out half."""
    reserved = held_out_ids(count, prefix=evaluator)
    development = [
        f"{evaluator}-dev-{n}" for n in range(1, 40) if not held_out(f"{evaluator}-dev-{n}")
    ]
    return [
        LabelledAnswer(
            id=label_id,
            evaluator=evaluator,
            question="how do I restart the router?",
            answer="Drain traffic first.",
            human=float(index % 2),
            context=("Drain traffic first, then restart.",),
            reference="Drain traffic first.",
            labelled_by="ana",
        )
        for index, label_id in enumerate([*reserved, *development[:count]])
    ]


def a_use_case(
    *, labelled: list[LabelledAnswer], judge: FakeJudge | None = None, bar: CalibrationBar = BAR
) -> tuple[CalibrateJudge, FakeJudge]:
    grader = judge or FakeJudge()
    return CalibrateJudge(labels=FakeLabels(labelled), judge=grader, bar=bar), grader


async def calibrate(use_case: CalibrateJudge, **kwargs: object) -> list[Calibration]:
    return await use_case.execute(
        CalibrateJudgeCommand(
            labels_path="evals/labels",
            caller=CALLER,
            evaluators=tuple(kwargs.get("evaluators", ())),  # type: ignore[arg-type]
        )
    )


class TestWhatItProduces:
    async def test_every_label_is_graded_and_split(self) -> None:
        use_case, judge = a_use_case(labelled=labels(6))

        [calibration] = await calibrate(use_case)

        assert len(judge.criteria_seen) == 12
        assert len(calibration.held_out) == 6
        assert len(calibration.development) == 6

    async def test_the_pair_keeps_what_the_human_said_next_to_what_the_judge_said(self) -> None:
        use_case, judge = a_use_case(labelled=labels(6))
        judge.verdict = 0.25

        [calibration] = await calibrate(use_case)

        assert {pair.judge for pair in calibration.held_out} == {0.25}
        assert {pair.human for pair in calibration.held_out} == {0.0, 1.0}

    async def test_it_asks_the_judge_the_way_the_runner_asks_it(self) -> None:
        # A calibration measured against a different criterion licenses a
        # prompt that never runs.
        use_case, judge = a_use_case(labelled=labels(6))

        [calibration] = await calibrate(use_case)

        assert "supported by the context" in judge.criteria_seen[0]
        assert calibration.criterion == judge.criteria_seen[0]

    async def test_the_record_names_the_judge_it_measured(self) -> None:
        use_case, _ = a_use_case(labelled=labels(6), judge=FakeJudge(alias="grader-4"))

        [calibration] = await calibrate(use_case)

        assert calibration.judge_alias == "grader-4"

    async def test_each_evaluator_gets_its_own_record(self) -> None:
        use_case, _ = a_use_case(
            labelled=[*labels(6), *labels(6, evaluator="relevance")],
        )

        calibrations = await calibrate(use_case)

        assert [c.evaluator for c in calibrations] == ["groundedness", "relevance"]

    async def test_it_can_be_asked_for_one_evaluator(self) -> None:
        use_case, judge = a_use_case(labelled=[*labels(6), *labels(6, evaluator="relevance")])

        calibrations = await calibrate(use_case, evaluators=("relevance",))

        assert [c.evaluator for c in calibrations] == ["relevance"]
        # And it did not quietly grade the labels it was not asked about.
        assert all("supported by the context" not in seen for seen in judge.criteria_seen)


class TestWhatItRefuses:
    async def test_too_few_held_out_labels_before_a_token_is_spent(self) -> None:
        use_case, judge = a_use_case(labelled=labels(2))

        with pytest.raises(LabelsTooFewError):
            await calibrate(use_case)

        assert judge.criteria_seen == []

    async def test_an_evaluator_with_no_criterion(self) -> None:
        # `safety` is scored by guardrails, not by a judge. A label for it
        # cannot be graded the way the runner grades anything.
        use_case, _ = a_use_case(labelled=labels(6, evaluator="safety"))

        with pytest.raises(ValidationError):
            await calibrate(use_case)

    async def test_labels_for_nothing_it_was_asked_about(self) -> None:
        use_case, _ = a_use_case(labelled=labels(6))

        with pytest.raises(ValidationError):
            await calibrate(use_case, evaluators=("relevance",))

    async def test_a_judge_nobody_could_read_stops_the_calibration(self) -> None:
        # Not a pair scored 0.0: the same lie as everywhere else in this
        # service, and here it would be baked into a record that licenses a gate.
        judge = FakeJudge()
        judge.failure = JudgeUnreadableError("I cannot grade this")
        use_case, _ = a_use_case(labelled=labels(6), judge=judge)

        with pytest.raises(JudgeUnreadableError):
            await calibrate(use_case)

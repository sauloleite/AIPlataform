"""The labels that ship with the repository, checked the way a dataset is.

A calibration is only as good as the label set under it, and a label set decays
in ways nobody notices: somebody adds ten good answers and the held-out half
stops containing anything a human rejected; somebody trims it and the sample
falls below what measures anything. Both leave a file that still parses and a
gate that has quietly stopped working.

Costs nothing -- no judge, no model, no network -- so it runs in `test-unit` on
every change, like the red-team and trajectory datasets.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evaluation.domain.calibration import DEFAULT_BAR, LabelledAnswer, held_out
from evaluation.domain.judging import CRITERIA
from evaluation.infrastructure.files import JsonlLabelSource

LABELS = Path(__file__).resolve().parents[3] / "evals/labels"

EVALUATORS = sorted(CRITERIA)


def labels_for(evaluator: str) -> list[LabelledAnswer]:
    return [label for label in JsonlLabelSource().load(str(LABELS)) if label.evaluator == evaluator]


class TestTheShippedLabels:
    def test_every_judged_evaluator_has_labels(self) -> None:
        # A judged evaluator with no labels cannot be calibrated, and an
        # evaluator that cannot be calibrated cannot run at all.
        for evaluator in EVALUATORS:
            assert labels_for(evaluator), evaluator

    @pytest.mark.parametrize("evaluator", EVALUATORS)
    def test_enough_of_them_are_held_out_to_measure_anything(self, evaluator: str) -> None:
        reserved = [label for label in labels_for(evaluator) if held_out(label.id)]

        assert len(reserved) >= DEFAULT_BAR.min_sample

    @pytest.mark.parametrize("evaluator", EVALUATORS)
    def test_both_halves_contain_answers_a_human_rejected(self, evaluator: str) -> None:
        # The failure this catches: a label set that grew until everything in
        # it is a good answer. A judge that says yes to everything then agrees
        # with the humans perfectly, and the gate it licenses is blind.
        for half in (True, False):
            scores = {
                label.human >= 0.5 for label in labels_for(evaluator) if held_out(label.id) is half
            }
            assert scores == {True, False}, half

    @pytest.mark.parametrize("evaluator", EVALUATORS)
    def test_every_label_says_who_labelled_it(self, evaluator: str) -> None:
        # "A human said so" is the entire authority of this file.
        for label in labels_for(evaluator):
            assert label.labelled_by, label.id

    def test_an_id_is_never_reused(self) -> None:
        # Two labels sharing an id would land in the same half by construction
        # and one of them would overwrite the other in the record.
        ids = [label.id for label in JsonlLabelSource().load(str(LABELS))]

        assert len(ids) == len(set(ids))

    def test_a_grounding_label_has_something_to_be_grounded_in(self) -> None:
        for label in labels_for("groundedness"):
            assert label.context, label.id

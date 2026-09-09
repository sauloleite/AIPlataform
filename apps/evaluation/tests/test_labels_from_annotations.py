"""Annotations becoming labels.

The join that makes error analysis pay twice: the reading that produces a
failure taxonomy also produces the labels a judge is calibrated against. What
has to be right is the arithmetic of what did NOT make it -- an export that
silently dropped most of its input would look like a small label set rather
than like a project with content capture switched off.
"""

from __future__ import annotations

from evaluation.application.use_cases.labels_from_annotations import LabelsFromAnnotations
from evaluation.domain.annotation import Annotation, make_annotation


def an_annotation(annotation_id: str, **kwargs: object) -> Annotation:
    defaults: dict[str, object] = {
        "annotation_id": annotation_id,
        "project_id": "proj-1",
        "trace_id": f"trace-{annotation_id}",
        "principal_id": "user-ana",
        "verdict": "bad",
        "failure_mode": "invented a number",
        "evaluator": "groundedness",
        "question": "how do I restart the router?",
        "answer": "In five minutes.",
    }
    return make_annotation(**{**defaults, **kwargs})  # type: ignore[arg-type]


class TestWhatBecomesALabel:
    def test_a_complete_annotation_does(self) -> None:
        export = LabelsFromAnnotations().execute([an_annotation("a1")])

        assert [label.id for label in export.labels] == ["a1"]
        assert export.skipped == 0

    def test_a_verdict_with_no_text_is_counted_rather_than_dropped(self) -> None:
        export = LabelsFromAnnotations().execute([an_annotation("a1", question="", answer="")])

        assert export.labels == ()
        assert export.skipped == 1

    def test_an_annotation_naming_no_evaluator_is_not_a_label(self) -> None:
        # It is still a finding for the taxonomy. It just cannot calibrate
        # anything, because nobody said which judgement it is about.
        export = LabelsFromAnnotations().execute([an_annotation("a1", evaluator="")])

        assert export.skipped == 1

    def test_they_are_grouped_by_the_evaluator_they_judge(self) -> None:
        export = LabelsFromAnnotations().execute(
            [
                an_annotation("a1", evaluator="groundedness"),
                an_annotation("a2", evaluator="relevance"),
                an_annotation("a3", evaluator="relevance"),
            ]
        )

        assert {name: len(labels) for name, labels in export.by_evaluator.items()} == {
            "groundedness": 1,
            "relevance": 2,
        }


class TestNotTwice:
    def test_an_annotation_already_in_the_label_files_is_not_appended_again(self) -> None:
        # A label exported twice is counted twice by a calibration, and both
        # copies land in the SAME half -- so it cannot even show up as
        # disagreement. It is a silent doubling of one person's opinion.
        export = LabelsFromAnnotations(known={"a1"}).execute([an_annotation("a1")])

        assert export.labels == ()
        assert export.duplicates == ("a1",)

    def test_the_same_annotation_twice_in_one_export(self) -> None:
        export = LabelsFromAnnotations().execute([an_annotation("a1"), an_annotation("a1")])

        assert len(export.labels) == 1
        assert export.duplicates == ("a1",)

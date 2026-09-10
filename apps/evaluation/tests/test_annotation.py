"""Reading a trace and naming what went wrong.

The taxonomy is the product. Everything here defends the two ways it stops
being one: a mode written three ways is three anecdotes instead of one finding,
and a verdict with no mode is an annotation nobody can act on.
"""

from __future__ import annotations

import pytest

from aia_errors import ValidationError
from evaluation.domain.annotation import (
    MAX_NOTE,
    Annotation,
    AnnotationVerdict,
    make_annotation,
    normalise_failure_mode,
    taxonomy,
)


def an_annotation(**kwargs: object) -> Annotation:
    defaults: dict[str, object] = {
        "annotation_id": "ann-1",
        "project_id": "proj-1",
        "trace_id": "trace-1",
        "principal_id": "user-ana",
        "verdict": "bad",
        "failure_mode": "invented a number",
    }
    return make_annotation(**{**defaults, **kwargs})  # type: ignore[arg-type]


class TestTheFailureMode:
    @pytest.mark.parametrize(
        ("written", "stored"),
        [
            ("Wrong number", "wrong-number"),
            ("wrong  number", "wrong-number"),
            ("WRONG_NUMBER", "wrong-number"),
            ("wrong/number", "wrong-number"),
            ("  wrong number  ", "wrong-number"),
            ("wrong-number!", "wrong-number"),
        ],
    )
    def test_the_same_failure_written_six_ways_is_one_entry(
        self, written: str, stored: str
    ) -> None:
        assert normalise_failure_mode(written) == stored

    def test_accents_are_folded_rather_than_dropped(self) -> None:
        # Two people, one language, one failure. A taxonomy that separated them
        # would report each as half as common as it is.
        assert normalise_failure_mode("alucinação") == normalise_failure_mode("alucinacao")

    def test_it_cannot_grow_without_limit(self) -> None:
        assert len(normalise_failure_mode("x " * 200)) <= 60

    def test_punctuation_alone_is_not_a_failure_mode(self) -> None:
        assert normalise_failure_mode("!!!") == ""


class TestWhatIsRefused:
    def test_a_bad_answer_without_a_reason(self) -> None:
        # The annotation everybody writes when the field is optional, and the
        # one nobody can do anything with.
        with pytest.raises(ValidationError):
            an_annotation(failure_mode="")

    def test_a_bad_answer_whose_reason_normalises_to_nothing(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation(failure_mode="???")

    def test_a_good_answer_that_carries_a_failure(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation(verdict="good", failure_mode="invented a number")

    def test_a_verdict_that_is_neither(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation(verdict="mostly fine")

    def test_an_evaluator_nobody_implements(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation(evaluator="vibes")

    def test_an_annotation_about_no_trace(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation(trace_id="")

    def test_a_note_the_size_of_a_transcript(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation(note="x" * (MAX_NOTE + 1))


class TestBecomingALabel:
    def test_a_verdict_alone_is_not_a_label(self) -> None:
        # The common case, and not a defect: content capture is off by default,
        # so most annotations are about a trace whose words were never stored.
        assert not an_annotation().is_label

    def test_it_needs_the_answer_as_well_as_the_evaluator(self) -> None:
        assert not an_annotation(evaluator="groundedness", question="q").is_label

    def test_a_complete_one_is(self) -> None:
        annotation = an_annotation(evaluator="groundedness", question="q", answer="a")

        assert annotation.is_label

    def test_a_bad_verdict_becomes_a_zero(self) -> None:
        label = an_annotation(evaluator="groundedness", question="q", answer="a").as_label()

        assert label.human == 0.0
        assert label.evaluator == "groundedness"
        assert label.labelled_by == "user-ana"

    def test_a_good_verdict_becomes_a_one(self) -> None:
        annotation = an_annotation(
            verdict="good",
            failure_mode="",
            evaluator="relevance",
            question="q",
            answer="a",
            context=["c"],
        )

        label = annotation.as_label()

        assert label.human == 1.0
        assert label.context == ("c",)

    def test_an_incomplete_one_refuses_rather_than_inventing_the_missing_half(self) -> None:
        with pytest.raises(ValidationError):
            an_annotation().as_label()


class TestTheTaxonomy:
    def test_it_counts_what_the_traces_produced(self) -> None:
        annotations = [
            an_annotation(annotation_id=f"a{n}", failure_mode=mode)
            for n, mode in enumerate(["invented a number", "Invented a number", "off topic"])
        ]

        assert [(entry.failure_mode, entry.count) for entry in taxonomy(annotations)] == [
            ("invented-a-number", 2),
            ("off-topic", 1),
        ]

    def test_ties_are_ordered_alphabetically_so_the_list_stops_moving(self) -> None:
        # A taxonomy people compare week to week has to be stable when nothing
        # changed. Two modes seen once each must not swap places between reads.
        annotations = [
            an_annotation(annotation_id="a1", failure_mode="wrong tool"),
            an_annotation(annotation_id="a2", failure_mode="off topic"),
        ]

        assert [entry.failure_mode for entry in taxonomy(annotations)] == [
            "off-topic",
            "wrong-tool",
        ]

    def test_a_good_answer_contributes_nothing(self) -> None:
        good = an_annotation(verdict="good", failure_mode="")

        assert taxonomy([good]) == ()

    def test_nothing_annotated_is_an_empty_taxonomy_not_an_error(self) -> None:
        assert taxonomy([]) == ()


def test_the_verdict_is_binary() -> None:
    # Three points collect the middle, and the middle is where disagreement
    # hides instead of being resolved.
    assert [v.value for v in AnnotationVerdict] == ["good", "bad"]

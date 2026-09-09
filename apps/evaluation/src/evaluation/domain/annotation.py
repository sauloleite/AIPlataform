"""What a person decided about one real trace.

The order this file exists to protect: **look at traces, name what went wrong,
then write the evaluator.** An evaluator written before that measures what its
author imagined the system does. The six evaluators this service started with
were written that way, and it is not obvious from their code which of them ever
caught anything real.

An annotation is the durable form of that reading. Three things make it more
than a comment box:

- the failure mode is **normalised**, so "Wrong number" and "wrong  number"
  are one entry in the taxonomy rather than two anecdotes;
- it is **counted**, because a mode seen once is an anecdote and a mode in a
  third of the annotated traces is the next evaluator to write;
- when it carries the question, the answer and the evaluator that should have
  caught the problem, it is also a human LABEL, which is what calibrates a
  judge (ADR-028). The taxonomy and the label set then come from the same
  reading, rather than from two separate acts of imagination.

Pure. Storing it is infrastructure; reading a trace is the console's job.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

from aia_errors import ValidationError
from evaluation.domain.calibration import LabelledAnswer
from evaluation.domain.judging import CRITERIA

#: Long enough for a sentence about what went wrong, short enough that nobody
#: pastes a transcript into it.
MAX_NOTE = 2000
MAX_FAILURE_MODE = 60


class AnnotationVerdict(StrEnum):
    GOOD = "good"
    BAD = "bad"


_SEPARATORS = re.compile(r"[\s_/]+")
_UNWANTED = re.compile(r"[^a-z0-9-]")


def normalise_failure_mode(raw: str) -> str:
    """A slug, so that a taxonomy is a taxonomy and not a list of spellings.

    Accents are folded rather than dropped: `alucinação` and `alucinacao` are
    the same failure written by two people, and a taxonomy that separates them
    reports each of them as half as common as it is.
    """
    folded = unicodedata.normalize("NFKD", raw.strip().lower())
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")
    slug = _UNWANTED.sub("", _SEPARATORS.sub("-", ascii_only)).strip("-")
    return re.sub(r"-{2,}", "-", slug)[:MAX_FAILURE_MODE]


@dataclass(frozen=True, slots=True)
class Annotation:
    id: str
    project_id: str
    trace_id: str
    verdict: AnnotationVerdict
    principal_id: str
    failure_mode: str | None = None
    note: str = ""
    #: Which evaluator should have caught this. Asked of the annotator rather
    #: than inferred later, because the person reading the trace is the only one
    #: who knows, and asking six months later means guessing.
    evaluator: str | None = None
    question: str = ""
    answer: str = ""
    context: tuple[str, ...] = ()
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def is_label(self) -> bool:
        """Whether this can calibrate a judge.

        Most annotations cannot, and that is not a defect: content capture is
        per project and off by default, so the common case is a verdict about a
        trace whose text the platform never stored. An annotation without the
        text would calibrate a judge against a question nobody can see.
        """
        return bool(self.evaluator and self.question and self.answer)

    def as_label(self) -> LabelledAnswer:
        if not self.is_label:
            raise ValidationError(
                "this annotation cannot become a label",
                annotation=self.id,
                needs="an evaluator, a question and an answer",
            )
        return LabelledAnswer(
            id=self.id,
            evaluator=self.evaluator or "",
            question=self.question,
            answer=self.answer,
            # The verdict IS the label. Binary on both sides on purpose: the
            # scale a judge answers on is 0..1, and a human who annotated a
            # trace as bad has said 0.
            human=1.0 if self.verdict is AnnotationVerdict.GOOD else 0.0,
            context=self.context,
            labelled_by=self.principal_id,
            note=self.note,
        )


def make_annotation(
    *,
    annotation_id: str,
    project_id: str,
    trace_id: str,
    principal_id: str,
    verdict: str,
    failure_mode: str = "",
    note: str = "",
    evaluator: str = "",
    question: str = "",
    answer: str = "",
    context: Sequence[str] = (),
) -> Annotation:
    """Builds one, refusing what would make the taxonomy meaningless."""
    if not trace_id:
        raise ValidationError("an annotation is about a trace")

    try:
        decided = AnnotationVerdict(verdict)
    except ValueError as error:
        raise ValidationError(
            "a verdict is good or bad", verdict=verdict, known=[v.value for v in AnnotationVerdict]
        ) from error

    mode = normalise_failure_mode(failure_mode) if failure_mode else None

    if decided is AnnotationVerdict.BAD and not mode:
        # "It was wrong" that does not say how is the annotation that teaches
        # nobody anything, and it is the one everybody writes when the field is
        # optional.
        raise ValidationError("a bad answer needs a failure mode: say what went wrong")

    if decided is AnnotationVerdict.GOOD and mode:
        raise ValidationError("a good answer has no failure mode", failure_mode=mode)

    if evaluator and evaluator not in CRITERIA:
        raise ValidationError(
            "no judged evaluator by that name", evaluator=evaluator, known=sorted(CRITERIA)
        )

    if len(note) > MAX_NOTE:
        raise ValidationError("that note is too long", limit=MAX_NOTE, length=len(note))

    return Annotation(
        id=annotation_id,
        project_id=project_id,
        trace_id=trace_id,
        verdict=decided,
        principal_id=principal_id,
        failure_mode=mode,
        note=note,
        evaluator=evaluator or None,
        question=question,
        answer=answer,
        context=tuple(context),
    )


@dataclass(frozen=True, slots=True)
class FailureModeCount:
    failure_mode: str
    count: int


def taxonomy(annotations: Sequence[Annotation]) -> tuple[FailureModeCount, ...]:
    """The failure modes these traces produced, commonest first.

    This is the output the whole surface exists for. Ties break alphabetically
    so the list does not reshuffle between two reads of the same data -- a
    taxonomy people compare week to week has to be stable when nothing changed.
    """
    counted = Counter(a.failure_mode for a in annotations if a.failure_mode)
    ordered = sorted(counted.items(), key=lambda pair: (-pair[1], pair[0]))
    return tuple(FailureModeCount(failure_mode=mode, count=count) for mode, count in ordered)

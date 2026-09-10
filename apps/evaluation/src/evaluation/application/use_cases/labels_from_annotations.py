"""Turning what people wrote about real traces into the label set.

This is the join that makes the annotation surface more than a comment box, and
it is the order ADR-021's successor argues for: read traces, name what went
wrong, and the labels a judge is calibrated against come out of that reading
rather than out of somebody imagining what the platform gets wrong.

Most annotations cannot be labels, and the count of what was skipped is part of
the output rather than a silence: an export that quietly dropped nine tenths of
the annotations would look like a small label set instead of a project with
content capture switched off.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from evaluation.domain.annotation import Annotation
from evaluation.domain.calibration import LabelledAnswer


@dataclass(frozen=True, slots=True)
class LabelExport:
    labels: tuple[LabelledAnswer, ...] = ()
    #: How many annotations carried no text or no evaluator, and so could not
    #: become labels. Reported, never inferred from the difference.
    skipped: int = 0
    #: Ids that would land in the label file twice.
    duplicates: tuple[str, ...] = ()

    @property
    def by_evaluator(self) -> dict[str, list[LabelledAnswer]]:
        grouped: dict[str, list[LabelledAnswer]] = {}
        for label in self.labels:
            grouped.setdefault(label.evaluator, []).append(label)
        return grouped


@dataclass(slots=True)
class LabelsFromAnnotations:
    #: Ids already in the label files. An annotation exported twice would be
    #: counted twice by a calibration, and the second copy would land in the
    #: same half as the first -- so it cannot even be caught as disagreement.
    known: set[str] = field(default_factory=set)

    def execute(self, annotations: Sequence[Annotation]) -> LabelExport:
        labels: list[LabelledAnswer] = []
        duplicates: list[str] = []
        skipped = 0

        for annotation in annotations:
            if not annotation.is_label:
                skipped += 1
                continue
            if annotation.id in self.known or any(label.id == annotation.id for label in labels):
                duplicates.append(annotation.id)
                continue
            labels.append(annotation.as_label())

        return LabelExport(
            labels=tuple(labels), skipped=skipped, duplicates=tuple(sorted(duplicates))
        )

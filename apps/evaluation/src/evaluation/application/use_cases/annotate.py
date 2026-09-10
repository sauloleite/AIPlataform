"""Recording what a person decided about a trace, and reading it back.

Thin on purpose: the rules are in the domain, and what is left here is the id,
the clock and the store. What it does add is the pairing -- every list comes
back with the taxonomy those annotations add up to, because a list of
annotations is a reading exercise and the counts are the finding.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from evaluation.application.dto import Caller
from evaluation.application.ports import AnnotationRepository
from evaluation.domain.annotation import (
    Annotation,
    FailureModeCount,
    make_annotation,
    normalise_failure_mode,
    taxonomy,
)

#: How many annotations the taxonomy is counted over. The list a caller sees is
#: capped for the page; the counts are not, or a taxonomy would change shape
#: with the page size.
TAXONOMY_SAMPLE = 1000


@dataclass(frozen=True, slots=True)
class RecordAnnotationCommand:
    caller: Caller
    trace_id: str
    verdict: str
    failure_mode: str = ""
    note: str = ""
    evaluator: str = ""
    question: str = ""
    answer: str = ""
    context: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AnnotationPage:
    items: list[Annotation]
    taxonomy: tuple[FailureModeCount, ...] = ()


@dataclass(slots=True)
class RecordAnnotation:
    annotations: AnnotationRepository

    async def execute(self, command: RecordAnnotationCommand) -> Annotation:
        annotation = make_annotation(
            annotation_id=str(uuid.uuid4()),
            project_id=command.caller.project_id,
            trace_id=command.trace_id,
            principal_id=command.caller.principal_id,
            verdict=command.verdict,
            failure_mode=command.failure_mode,
            note=command.note,
            evaluator=command.evaluator,
            question=command.question,
            answer=command.answer,
            context=command.context,
        )
        await self.annotations.save(annotation)
        return annotation


@dataclass(slots=True)
class ListAnnotations:
    annotations: AnnotationRepository
    taxonomy_sample: int = field(default=TAXONOMY_SAMPLE)

    async def execute(
        self,
        caller: Caller,
        *,
        limit: int,
        trace_id: str | None = None,
        failure_mode: str | None = None,
    ) -> AnnotationPage:
        items = await self.annotations.list(
            caller.project_id,
            limit=limit,
            trace_id=trace_id,
            # Normalised here as well as on the way in: a caller filtering by
            # "Wrong number" is asking for the mode they can see in the
            # taxonomy, and an exact-match query would answer with nothing.
            failure_mode=normalise_failure_mode(failure_mode) if failure_mode else None,
        )

        # Counted over the project, not over the page. A taxonomy that changed
        # shape when somebody passed `limit=5` would be describing the page.
        counted = await self.annotations.list(caller.project_id, limit=self.taxonomy_sample)
        return AnnotationPage(items=items, taxonomy=taxonomy(counted))

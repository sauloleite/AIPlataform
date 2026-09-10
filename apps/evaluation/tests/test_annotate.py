"""Recording and reading annotations.

Two things the use case has to get right, and both are about counting: one
person changing their mind is one annotation, and the taxonomy describes the
project rather than whichever page somebody asked for.
"""

from __future__ import annotations

import pytest

from aia_errors import ValidationError
from evaluation.application.dto import Caller
from evaluation.application.use_cases.annotate import (
    ListAnnotations,
    RecordAnnotation,
    RecordAnnotationCommand,
)
from evaluation.domain.annotation import Annotation
from evaluation.infrastructure.in_memory import InMemoryAnnotationRepository

ANA = Caller(principal_id="user-ana", project_id="proj-1", access_token="ana-token")
BRUNO = Caller(principal_id="user-bruno", project_id="proj-1", access_token="bruno-token")
NEIGHBOUR = Caller(principal_id="user-carla", project_id="proj-2", access_token="carla-token")


class Harness:
    def __init__(self) -> None:
        self.repository = InMemoryAnnotationRepository()
        self.record = RecordAnnotation(annotations=self.repository)
        self.list = ListAnnotations(annotations=self.repository)

    async def annotate(self, caller: Caller = ANA, **kwargs: object) -> Annotation:
        defaults: dict[str, object] = {
            "trace_id": "trace-1",
            "verdict": "bad",
            "failure_mode": "invented a number",
        }
        return await self.record.execute(
            RecordAnnotationCommand(caller=caller, **{**defaults, **kwargs})  # type: ignore[arg-type]
        )


class TestRecording:
    async def test_it_belongs_to_the_caller_and_their_project(self) -> None:
        harness = Harness()

        annotation = await harness.annotate()

        assert annotation.project_id == "proj-1"
        assert annotation.principal_id == "user-ana"
        assert annotation.id

    async def test_one_person_changing_their_mind_is_one_annotation(self) -> None:
        # Otherwise a failure mode is inflated by however often its reader
        # hesitated, and the taxonomy measures hesitation.
        harness = Harness()
        await harness.annotate(failure_mode="invented a number")
        await harness.annotate(failure_mode="off topic")

        page = await harness.list.execute(ANA, limit=25)

        assert len(page.items) == 1
        assert [entry.failure_mode for entry in page.taxonomy] == ["off-topic"]

    async def test_two_people_disagreeing_about_one_trace_is_two(self) -> None:
        # Inter-annotator disagreement is the signal, not a duplicate.
        harness = Harness()
        await harness.annotate(caller=ANA, failure_mode="invented a number")
        await harness.annotate(caller=BRUNO, verdict="good", failure_mode="")

        page = await harness.list.execute(ANA, limit=25)

        assert len(page.items) == 2

    async def test_the_rules_are_the_domain_s_and_are_not_bypassed_here(self) -> None:
        harness = Harness()

        with pytest.raises(ValidationError):
            await harness.annotate(failure_mode="")


class TestReading:
    async def test_another_project_s_annotations_are_not_visible(self) -> None:
        harness = Harness()
        await harness.annotate(caller=ANA)
        await harness.annotate(caller=NEIGHBOUR)

        page = await harness.list.execute(NEIGHBOUR, limit=25)

        assert [a.principal_id for a in page.items] == ["user-carla"]

    async def test_one_trace_can_be_read_on_its_own(self) -> None:
        harness = Harness()
        await harness.annotate(trace_id="trace-1")
        await harness.annotate(caller=BRUNO, trace_id="trace-2", failure_mode="off topic")

        page = await harness.list.execute(ANA, limit=25, trace_id="trace-2")

        assert [a.trace_id for a in page.items] == ["trace-2"]

    async def test_the_taxonomy_describes_the_project_not_the_page(self) -> None:
        # A caller asking for one annotation still needs to know which failure
        # modes exist, or the console would show a taxonomy of one.
        harness = Harness()
        await harness.annotate(caller=ANA, trace_id="t1", failure_mode="invented a number")
        await harness.annotate(caller=BRUNO, trace_id="t2", failure_mode="off topic")

        page = await harness.list.execute(ANA, limit=1)

        assert len(page.items) == 1
        assert len(page.taxonomy) == 2

    async def test_filtering_accepts_the_mode_as_a_human_wrote_it(self) -> None:
        # The console shows `invented-a-number`, and somebody types "Invented a
        # number". An exact-match query would answer with nothing and read as
        # "no such failure".
        harness = Harness()
        await harness.annotate(failure_mode="invented a number")

        page = await harness.list.execute(ANA, limit=25, failure_mode="Invented A Number")

        assert len(page.items) == 1

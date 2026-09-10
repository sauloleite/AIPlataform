"""What the Mongo adapters actually send, for the rules Mongo enforces at runtime.

These assert the shape of an update document, which is the one place in this
service where that is the right thing to assert: `_id` is immutable in MongoDB,
and no unit test can see that without a server. The in-memory repository the
other tests use replaces a record wholesale, so it agrees with production about
the outcome and says nothing about the operators -- and the disagreement was
real: re-annotating a trace raised "would modify the immutable field '_id'"
while every test passed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from evaluation.domain.annotation import make_annotation
from evaluation.domain.sampling import Sample
from evaluation.infrastructure.mongo import MongoAnnotationRepository, MongoSampleRepository


@dataclass(slots=True)
class RecordingCollection:
    updates: list[tuple[dict[str, Any], dict[str, Any], bool]] = field(default_factory=list)

    async def update_one(
        self, query: dict[str, Any], update: dict[str, Any], upsert: bool = False
    ) -> None:
        self.updates.append((query, update, upsert))


@dataclass(slots=True)
class RecordingDatabase:
    collections: dict[str, RecordingCollection] = field(default_factory=dict)

    def __getitem__(self, name: str) -> RecordingCollection:
        return self.collections.setdefault(name, RecordingCollection())


def an_annotation() -> Any:
    return make_annotation(
        annotation_id="ann-1",
        project_id="proj-1",
        trace_id="trace-1",
        principal_id="user-ana",
        verdict="bad",
        failure_mode="invented a number",
    )


class TestSavingAnAnnotation:
    async def test_the_update_never_touches_the_immutable_id(self) -> None:
        database = RecordingDatabase()
        await MongoAnnotationRepository(database).save(an_annotation())  # type: ignore[arg-type]

        _, update, _ = database["annotations"].updates[0]

        assert "_id" not in update["$set"]
        assert update["$setOnInsert"]["_id"] == "ann-1"

    async def test_it_matches_the_person_and_the_trace_rather_than_the_id(self) -> None:
        # Two people annotating one trace stay two records; one person
        # annotating it twice is the same record with a new verdict.
        database = RecordingDatabase()
        await MongoAnnotationRepository(database).save(an_annotation())  # type: ignore[arg-type]

        query, _, upsert = database["annotations"].updates[0]

        assert query == {
            "project_id": "proj-1",
            "trace_id": "trace-1",
            "principal_id": "user-ana",
        }
        assert upsert

    async def test_a_changed_verdict_reaches_the_document(self) -> None:
        database = RecordingDatabase()
        await MongoAnnotationRepository(database).save(an_annotation())  # type: ignore[arg-type]

        _, update, _ = database["annotations"].updates[0]

        assert update["$set"]["verdict"] == "bad"
        assert update["$set"]["failure_mode"] == "invented-a-number"

    async def test_the_creation_date_is_not_rewritten_by_a_change_of_mind(self) -> None:
        database = RecordingDatabase()
        await MongoAnnotationRepository(database).save(an_annotation())  # type: ignore[arg-type]

        _, update, _ = database["annotations"].updates[0]

        assert "created_at" not in update["$set"]
        assert "created_at" in update["$setOnInsert"]


class TestSavingASample:
    async def test_a_redelivered_event_does_not_overwrite_the_first_score(self) -> None:
        # `$setOnInsert` for the whole document: the stream delivers at least
        # once, and the second delivery must find the sample already there
        # rather than re-scoring it.
        database = RecordingDatabase()
        sample = Sample(id="s1", project_id="proj-1", request_id="req-1", alias="chat-local")

        await MongoSampleRepository(database).save(sample)  # type: ignore[arg-type]

        query, update, upsert = database["online_samples"].updates[0]

        assert query == {"request_id": "req-1"}
        assert "$set" not in update
        assert update["$setOnInsert"]["_id"] == "s1"
        assert upsert

"""The outbox, and the relay that drains it.

The point of the pattern is that the event is written in the same transaction as
the state change, so a crash between "saved" and "published" cannot lose it. The
tests below are about what happens AFTER that: the relay is where an event gets
published twice, or never, or where one bad event buries every other.

The Mongo collection is a fake rather than a container. What is being tested is
the relay's decisions -- lease, publish, mark, give up -- not whether Mongo can
store a document.
"""

from __future__ import annotations

from typing import Any

import pytest

from aia_messaging import CloudEvent, EventType, MongoOutbox, OutboxRelay, new_event


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    """Evaluates the QUERY, rather than reimplementing what it means.

    This started as a fake that checked the lease itself, and it made the lease
    test pass with the lease clause deleted from the code under test -- the fake
    was doing the work and the test was watching the fake. A fake has to be
    driven by the same input the real thing is driven by, or it tests itself.
    """
    for field, condition in query.items():
        if field == "$or":
            if not any(_matches(document, clause) for clause in condition):
                return False
            continue
        if not isinstance(condition, dict):
            if document.get(field) != condition:
                return False
            continue
        for operator, operand in condition.items():
            value = document.get(field)
            if operator == "$exists" and (value is not None) != operand:
                return False
            if operator == "$lt" and not (value is not None and value < operand):
                return False
    return True


class FakeCollection:
    """Enough Mongo to exercise the relay, and no more."""

    def __init__(self) -> None:
        self.documents: list[dict[str, Any]] = []
        self.indexes: list[Any] = []

    async def create_index(self, keys: Any, **options: Any) -> None:
        self.indexes.append((keys, options))

    async def insert_many(self, documents: list[dict[str, Any]], **_: Any) -> None:
        existing = {document["_id"] for document in self.documents}
        self.documents.extend(d for d in documents if d["_id"] not in existing)

    async def find_one_and_update(
        self, query: dict[str, Any], update: dict[str, Any], **_: Any
    ) -> dict[str, Any] | None:
        for document in self.documents:
            if not _matches(document, query):
                continue
            document.update(update.get("$set", {}))
            for field, amount in update.get("$inc", {}).items():
                document[field] = document.get(field, 0) + amount
            return dict(document)
        return None

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        return next((d for d in self.documents if d["_id"] == query["_id"]), None)

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        for document in self.documents:
            if document["_id"] != query["_id"]:
                continue
            document.update(update.get("$set", {}))
            for field in update.get("$unset", {}):
                document.pop(field, None)

    async def count_documents(self, query: dict[str, Any]) -> int:
        return sum(1 for d in self.documents if d["status"] == query["status"])


class FakeDatabase:
    def __init__(self, collection: FakeCollection) -> None:
        self._collection = collection

    def __getitem__(self, _name: str) -> FakeCollection:
        return self._collection


class RecordingPublisher:
    def __init__(self) -> None:
        self.published: list[CloudEvent] = []
        self.fail_for: set[str] = set()

    async def publish(self, event: CloudEvent) -> None:
        if event.id in self.fail_for:
            raise RuntimeError("redis said no")
        self.published.append(event)

    async def publish_all(self, events: list[CloudEvent]) -> None:
        for event in events:
            await self.publish(event)


def an_event(project_id: str = "proj-1") -> CloudEvent:
    return new_event(
        type=EventType.USAGE_RECORDED, source="aia-test", project_id=project_id, data={"n": 1}
    )


@pytest.fixture
def world() -> tuple[MongoOutbox, RecordingPublisher, FakeCollection]:
    collection = FakeCollection()
    outbox = MongoOutbox(FakeDatabase(collection))
    return outbox, RecordingPublisher(), collection


class TestAppending:
    async def test_the_same_event_appended_twice_is_stored_once(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, _, collection = world
        event = an_event()

        await outbox.append([event])
        await outbox.append([event])

        # The CloudEvent id IS the document id, which is what makes a retried
        # append harmless rather than a duplicate publish.
        assert len(collection.documents) == 1

    async def test_appending_nothing_touches_nothing(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, _, collection = world

        await outbox.append([])

        assert collection.documents == []


class TestDraining:
    async def test_publishes_and_marks(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, collection = world
        await outbox.append([an_event()])

        assert await OutboxRelay(outbox, publisher).drain() == 1
        assert collection.documents[0]["status"] == "published"

    async def test_a_published_event_is_not_published_again(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, _ = world
        await outbox.append([an_event()])
        relay = OutboxRelay(outbox, publisher)

        await relay.drain()
        await relay.drain()

        # A relay that republished on every pass would multiply every fact in
        # the platform by however often it ran.
        assert len(publisher.published) == 1

    async def test_one_failing_event_does_not_stop_the_rest(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, _ = world
        bad, good = an_event("bad"), an_event("good")
        publisher.fail_for.add(bad.id)
        await outbox.append([bad, good])

        await OutboxRelay(outbox, publisher).drain()

        # The batch continues. Otherwise one unpublishable event holds up every
        # fact behind it, indefinitely.
        assert [event.subject for event in publisher.published] == ["good"]

    async def test_a_failed_event_stays_pending_and_is_retried(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, collection = world
        event = an_event()
        publisher.fail_for.add(event.id)
        await outbox.append([event])
        relay = OutboxRelay(outbox, publisher, max_attempts=5)

        await relay.drain()
        assert collection.documents[0]["status"] == "pending"

        publisher.fail_for.clear()
        assert await relay.drain() == 1

    async def test_it_gives_up_after_max_attempts(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, collection = world
        event = an_event()
        publisher.fail_for.add(event.id)
        await outbox.append([event])
        relay = OutboxRelay(outbox, publisher, max_attempts=2)

        for _ in range(3):
            await relay.drain()

        # `failed` rather than `pending` forever: the event stays visible for
        # somebody to look at instead of spinning and burying the queue.
        assert collection.documents[0]["status"] == "failed"

    async def test_the_error_reaches_the_caller(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, _ = world
        event = an_event()
        publisher.fail_for.add(event.id)
        await outbox.append([event])

        seen: list[str] = []
        relay = OutboxRelay(outbox, publisher, on_error=lambda error, _: seen.append(str(error)))
        await relay.drain()

        # A relay that swallowed the reason would leave an operator with a
        # growing pending count and nothing to act on.
        assert seen == ["redis said no"]


class TestLeasing:
    async def test_a_leased_event_is_not_handed_to_a_second_relay(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, _, _ = world
        await outbox.append([an_event()])

        first = await outbox.lease(10, lease_ms=30_000)
        second = await outbox.lease(10, lease_ms=30_000)

        # Two replicas run this relay. Without the lease they would both publish
        # every event, and every consumer would see each fact twice.
        assert len(first) == 1
        assert second == []

    async def test_an_expired_lease_is_reclaimed(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, _, _ = world
        await outbox.append([an_event()])

        await outbox.lease(10, lease_ms=-1)
        reclaimed = await outbox.lease(10, lease_ms=30_000)

        # A relay that died mid-publish must not hold the event forever.
        assert len(reclaimed) == 1

    async def test_pending_count_is_what_an_operator_watches(
        self, world: tuple[MongoOutbox, RecordingPublisher, FakeCollection]
    ) -> None:
        outbox, publisher, _ = world
        await outbox.append([an_event("a"), an_event("b")])

        assert await outbox.pending_count() == 2
        await OutboxRelay(outbox, publisher).drain()
        assert await outbox.pending_count() == 0

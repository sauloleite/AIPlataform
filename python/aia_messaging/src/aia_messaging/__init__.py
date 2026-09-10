"""CloudEvents envelope and Redis Streams publisher.

Mirrors `@aia/messaging`: the same envelope, the same event names and the same
transport, so a Python producer and a TypeScript consumer understand each other
with no translator in between.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final, Protocol

from aia_errors import ValidationError

TYPE_PATTERN: Final = re.compile(r"^aia\.[a-z0-9]+(\.[a-z0-9_]+)+\.v\d+$")


class EventType:
    USAGE_RECORDED: Final = "aia.inference.usage.recorded.v1"
    PROJECT_CREATED: Final = "aia.governance.project.created.v1"
    BUDGET_CHANGED: Final = "aia.governance.budget.changed.v1"
    POLICY_CHANGED: Final = "aia.governance.policy.changed.v1"
    AGENT_RUN_FINISHED: Final = "aia.agent.run.finished.v1"
    APPROVAL_REQUESTED: Final = "aia.agent.approval.requested.v1"
    TOOL_INVOKED: Final = "aia.tools.tool.invoked.v1"
    ASSET_PUBLISHED: Final = "aia.registry.asset.published.v1"
    ASSET_DEPRECATED: Final = "aia.registry.asset.deprecated.v1"
    DOCUMENT_INGESTED: Final = "aia.knowledge.document.ingested.v1"
    INGESTION_FAILED: Final = "aia.knowledge.ingestion.failed.v1"
    # Declared, not yet published: aia-identity emits no event today. It stays
    # here so the name is decided once rather than invented at the call site.
    PRINCIPAL_CHANGED: Final = "aia.identity.principal.changed.v1"
    # Declared, not yet published: aia-document-processing does not exist yet
    # (roadmap M7). aia-knowledge parses text inline until it does.
    DOCUMENT_PARSED: Final = "aia.documents.document.parsed.v1"
    EVALUATION_FINISHED: Final = "aia.evaluation.run.finished.v1"


@dataclass(frozen=True, slots=True)
class CloudEvent:
    type: str
    source: str
    subject: str
    data: dict[str, Any]
    id: str
    time: str
    traceparent: str | None = None
    idempotencykey: str | None = None
    specversion: str = "1.0"
    datacontenttype: str = "application/json"

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "specversion": self.specversion,
            "type": self.type,
            "source": self.source,
            "id": self.id,
            "time": self.time,
            "subject": self.subject,
            "datacontenttype": self.datacontenttype,
            "data": self.data,
        }
        if self.traceparent is not None:
            payload["traceparent"] = self.traceparent
        if self.idempotencykey is not None:
            payload["idempotencykey"] = self.idempotencykey
        return payload


def new_event(
    *,
    type: str,  # noqa: A002 - the CloudEvents field name
    source: str,
    project_id: str,
    data: dict[str, Any],
    traceparent: str | None = None,
    idempotency_key: str | None = None,
    event_id: str | None = None,
    occurred_at: datetime | None = None,
) -> CloudEvent:
    if not TYPE_PATTERN.match(type):
        raise ValidationError("event type must follow aia.<domain>.<fact>.v<N>", type=type)
    if not project_id:
        raise ValidationError("projectId is required: project is the platform tenant")

    return CloudEvent(
        type=type,
        source=source,
        subject=project_id,
        data=data,
        id=event_id or str(uuid.uuid4()),
        time=(occurred_at or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
        traceparent=traceparent,
        idempotencykey=idempotency_key,
    )


class EventPublisher(Protocol):
    async def publish(self, event: CloudEvent) -> None: ...


class RedisLike(Protocol):
    """The one Redis call the publisher makes, named precisely.

    Precisely, because the loose version did not match the real client: `**kwargs`
    demands an implementation that takes arbitrary keywords, `async def` demands
    a Coroutine where redis-py declares an Awaitable, and `dict[str, str]` is
    invariant against the far wider key type redis-py accepts. Spelling out the
    two arguments actually used is what lets both the real client and a fake
    satisfy the same protocol.
    """

    def xadd(
        self, name: str, fields: Any, *, maxlen: int | None = ..., approximate: bool = ...
    ) -> Any: ...


class RedisConsumerLike(Protocol):
    """What a consumer group needs, named as precisely as the publisher's.

    Separate from `RedisLike` rather than added to it: a publisher fake should
    not have to implement four methods it never calls, and a service that only
    produces should not be able to consume by accident.
    """

    # `id`, `min` and `max` shadow builtins, and have to: they are redis-py's own
    # parameter names, and a protocol that renamed them would be satisfied by
    # nothing. Same reasoning as the publisher's docstring above.
    def xgroup_create(
        self,
        name: str,
        groupname: str,
        id: str = ...,  # noqa: A002
        mkstream: bool = ...,
    ) -> Any: ...
    def xreadgroup(
        self,
        groupname: str,
        consumername: str,
        streams: Any,
        count: int | None = ...,
        block: int | None = ...,
    ) -> Any: ...
    def xack(self, name: str, groupname: str, *ids: str) -> Any: ...
    def xpending_range(
        self,
        name: str,
        groupname: str,
        min: str,  # noqa: A002
        max: str,  # noqa: A002
        count: int,
    ) -> Any: ...


@dataclass(slots=True)
class RedisStreamPublisher:
    """One stream per event type, with an approximate length cap."""

    redis: RedisLike
    key_prefix: str = "aia:events"
    max_length: int = 100_000

    async def publish(self, event: CloudEvent) -> None:
        await self.redis.xadd(
            f"{self.key_prefix}:{event.type}",
            {"event": json.dumps(event.to_dict())},
            maxlen=self.max_length,
            approximate=True,
        )


@dataclass(slots=True)
class InMemoryEventPublisher:
    """Test fake. Honours the contract and lets you inspect what was published."""

    published: list[CloudEvent]

    def __init__(self) -> None:
        self.published = []

    async def publish(self, event: CloudEvent) -> None:
        self.published.append(event)

    def of_type(self, event_type: str) -> Sequence[CloudEvent]:
        return [event for event in self.published if event.type == event_type]


class EventHandler(Protocol):
    """Handles one event. MUST be idempotent: it may be called more than once.

    At-least-once is what a stream gives you. A handler that assumes otherwise
    double-counts the first time a consumer restarts mid-batch.
    """

    async def __call__(self, event: CloudEvent) -> None: ...


class EventSubscriber(Protocol):
    async def subscribe(self, event_type: str, handler: EventHandler) -> None: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...


OUTBOX_COLLECTION: Final = "outbox"


@dataclass(slots=True)
class OutboxRecord:
    id: str
    event: CloudEvent
    status: str
    attempts: int
    created_at: datetime
    published_at: datetime | None = None
    last_error: str | None = None
    #: Optimistic lease, so two relay replicas never publish the same event.
    leased_until: datetime | None = None


class MongoLike(Protocol):
    """The slice of a Mongo database this needs. Avoids coupling to a driver."""

    def __getitem__(self, name: str) -> Any: ...


@dataclass(slots=True)
class MongoOutbox:
    """The outbox pattern (reference doc 02, principle 3).

    The event is written in the SAME transaction as the state change, and a
    relay publishes whatever is pending. Without it, a crash between "saved" and
    "published" leaves the system inconsistent -- and a distributed transaction
    across Mongo and Redis would be worse than the problem.
    """

    database: MongoLike
    collection_name: str = OUTBOX_COLLECTION

    @property
    def _collection(self) -> Any:
        return self.database[self.collection_name]

    async def ensure_indexes(self) -> None:
        await self._collection.create_index([("status", 1), ("leased_until", 1), ("created_at", 1)])
        # A published event need not live forever: whoever consumes it already
        # has it, and the outbox is a handover, not an archive.
        await self._collection.create_index(
            "published_at",
            expireAfterSeconds=7 * 24 * 60 * 60,
            partialFilterExpression={"status": "published"},
        )

    async def append(self, events: Sequence[CloudEvent], session: Any = None) -> None:
        """Writes the events beside the state change. Pass the transaction session."""
        if not events:
            return
        now = datetime.now(tz=UTC)
        documents = [
            {
                "_id": event.id,
                "event": event.to_dict(),
                "status": "pending",
                "attempts": 0,
                "created_at": now,
            }
            for event in events
        ]
        # `ordered=False`: one duplicate id must not stop the rest. A duplicate
        # means the same event was appended twice, which the id makes harmless.
        await self._collection.insert_many(documents, ordered=False, session=session)

    async def lease(self, limit: int, lease_ms: int) -> list[OutboxRecord]:
        now = datetime.now(tz=UTC)
        leased_until = now + timedelta(milliseconds=lease_ms)
        leased: list[OutboxRecord] = []

        for _ in range(limit):
            document = await self._collection.find_one_and_update(
                {
                    "status": "pending",
                    "$or": [
                        {"leased_until": {"$exists": False}},
                        {"leased_until": {"$lt": now}},
                    ],
                },
                {"$set": {"leased_until": leased_until}, "$inc": {"attempts": 1}},
                sort=[("created_at", 1)],
                return_document=True,
            )
            if document is None:
                break
            leased.append(_record_of(document))
        return leased

    async def mark_published(self, event_id: str) -> None:
        await self._collection.update_one(
            {"_id": event_id},
            {
                "$set": {"status": "published", "published_at": datetime.now(tz=UTC)},
                "$unset": {"leased_until": ""},
            },
        )

    async def mark_failed(self, event_id: str, error: str, max_attempts: int) -> None:
        document = await self._collection.find_one({"_id": event_id})
        attempts = 0 if document is None else int(document.get("attempts", 0))
        # Past `max_attempts` the event stops being retried and stays visible for
        # somebody to look at, rather than spinning forever and burying the rest.
        status = "failed" if attempts >= max_attempts else "pending"
        await self._collection.update_one(
            {"_id": event_id},
            {"$set": {"status": status, "last_error": error}, "$unset": {"leased_until": ""}},
        )

    async def pending_count(self) -> int:
        count: int = await self._collection.count_documents({"status": "pending"})
        return count


def _record_of(document: dict[str, Any]) -> OutboxRecord:
    raw = document["event"]
    return OutboxRecord(
        id=document["_id"],
        event=CloudEvent(**raw) if isinstance(raw, dict) else raw,
        status=document["status"],
        attempts=int(document.get("attempts", 0)),
        created_at=document["created_at"],
        published_at=document.get("published_at"),
        last_error=document.get("last_error"),
        leased_until=document.get("leased_until"),
    )


@dataclass(slots=True)
class OutboxRelay:
    """Reads the outbox and publishes. Runs inside the service or beside it."""

    outbox: MongoOutbox
    publisher: EventPublisher
    batch_size: int = 100
    interval_ms: int = 1_000
    lease_ms: int = 30_000
    max_attempts: int = 10
    on_error: Callable[[BaseException, OutboxRecord], None] | None = None
    _running: bool = field(default=False, init=False)

    async def drain(self) -> int:
        """One pass. Returns how many were published."""
        records = await self.outbox.lease(self.batch_size, self.lease_ms)
        published = 0

        for record in records:
            try:
                await self.publisher.publish(record.event)
            except Exception as error:
                if self.on_error is not None:
                    self.on_error(error, record)
                await self.outbox.mark_failed(record.id, str(error), self.max_attempts)
                continue
            await self.outbox.mark_published(record.id)
            published += 1

        return published

    async def start(self) -> None:
        self._running = True
        while self._running:
            await self.drain()
            await asyncio.sleep(self.interval_ms / 1000)

    async def stop(self) -> None:
        self._running = False


@dataclass(slots=True)
class RedisStreamSubscriber:
    """Consumes with a consumer group, so replicas share the work.

    At-least-once, deliberately. A handler that raises leaves the message
    UNACKNOWLEDGED, so it comes back on the next read -- which is what makes a
    transient failure recoverable and why every handler has to be idempotent.
    Past `max_deliveries` it is dead-lettered rather than retried forever: one
    poisonous message must not stop the stream behind it.
    """

    redis: RedisConsumerLike
    group: str
    consumer: str
    key_prefix: str = "aia:events"
    batch_size: int = 10
    block_ms: int = 5_000
    max_deliveries: int = 5
    on_error: Callable[[BaseException, CloudEvent], None] | None = None
    on_dead_letter: Callable[[CloudEvent, int], None] | None = None
    _handlers: dict[str, list[EventHandler]] = field(default_factory=dict, init=False)
    _running: bool = field(default=False, init=False)

    def _stream_key(self, event_type: str) -> str:
        return f"{self.key_prefix}:{event_type}"

    async def subscribe(self, event_type: str, handler: EventHandler) -> None:
        self._handlers.setdefault(event_type, []).append(handler)
        try:
            await self.redis.xgroup_create(
                self._stream_key(event_type), self.group, id="$", mkstream=True
            )
        except Exception as error:
            # BUSYGROUP: the group already exists, which is the normal case on
            # every boot after the first.
            if "BUSYGROUP" not in str(error):
                raise

    async def read_once(self) -> int:
        """One read cycle. Public so a test can drive it without an endless loop."""
        if not self._handlers:
            return 0

        streams = {self._stream_key(event_type): ">" for event_type in self._handlers}
        reply = await self.redis.xreadgroup(
            self.group, self.consumer, streams, count=self.batch_size, block=self.block_ms
        )
        if not reply:
            return 0

        handled = 0
        for stream, entries in reply:
            for entry_id, fields in entries:
                handled += await self._dispatch(stream, entry_id, fields)
        return handled

    async def _dispatch(self, stream: str, entry_id: str, fields: dict[str, str]) -> int:
        raw = fields.get("event")
        if raw is None:
            # Nothing to hand a handler. Acknowledged rather than left pending,
            # or it would be redelivered until it dead-letters for no reason.
            await self.redis.xack(stream, self.group, entry_id)
            return 0

        event = CloudEvent(**json.loads(raw))

        for handler in self._handlers.get(event.type, []):
            try:
                await handler(event)
            except Exception as error:
                if self.on_error is not None:
                    self.on_error(error, event)
                deliveries = await self._delivery_count(stream, entry_id)
                if deliveries < self.max_deliveries:
                    # NOT acknowledged: it returns on the next read.
                    return 0
                if self.on_dead_letter is not None:
                    self.on_dead_letter(event, deliveries)

        await self.redis.xack(stream, self.group, entry_id)
        return 1

    async def _delivery_count(self, stream: str, entry_id: str) -> int:
        pending = await self.redis.xpending_range(
            stream, self.group, min=entry_id, max=entry_id, count=1
        )
        if not pending:
            return 1
        return int(pending[0]["times_delivered"])

    async def start(self) -> None:
        self._running = True
        while self._running:
            await self.read_once()

    async def stop(self) -> None:
        self._running = False


__all__ = [
    "OUTBOX_COLLECTION",
    "CloudEvent",
    "EventHandler",
    "EventPublisher",
    "EventSubscriber",
    "EventType",
    "InMemoryEventPublisher",
    "MongoOutbox",
    "OutboxRecord",
    "OutboxRelay",
    "RedisConsumerLike",
    "RedisStreamPublisher",
    "RedisStreamSubscriber",
    "new_event",
]

"""CloudEvents envelope and Redis Streams publisher.

Mirrors `@aia/messaging`: the same envelope, the same event names and the same
transport, so a Python producer and a TypeScript consumer understand each other
with no translator in between.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
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


__all__ = [
    "CloudEvent",
    "EventPublisher",
    "EventType",
    "InMemoryEventPublisher",
    "RedisStreamPublisher",
    "new_event",
]

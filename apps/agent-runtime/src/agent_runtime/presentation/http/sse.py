"""Server-Sent Events for a run (reference doc 03 §6).

Named events, an incrementing `id` for reconnection, and a heartbeat so a proxy
does not drop the connection while a model is thinking or a human is deciding.
Deliberately the same shape as the Node side's `SseWriter`: one SSE dialect
across the platform means one client helper in the console.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from agent_runtime.application.dto import RunEvent
from aia_errors import DomainError, problem_from_unknown

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 15.0

#: Ends the queue. A sentinel object rather than None, so an event that happened
#: to be falsy could never be read as "the run is over".
_DONE = object()


async def sse_stream(events: AsyncIterator[RunEvent], instance: str) -> AsyncIterator[bytes]:
    """Frames run events, with a heartbeat between them.

    The run is drained by a background task into a queue, and this generator
    reads the queue with a timeout. Racing the run generator directly against a
    timeout does not work: a timeout leaves the pending `__anext__` running, and
    closing the response then trips over a generator that is still in flight.

    Once the first byte is out the status line is already sent, so a failure can
    only be reported as an `error` EVENT -- never as an HTTP status. That is why
    the error is framed here rather than allowed to propagate.
    """
    queue: asyncio.Queue[Any] = asyncio.Queue()

    async def drain() -> None:
        try:
            async for event in events:
                await queue.put(event)
        except Exception as error:  # any failure is reported to the client below
            await queue.put(error)
        else:
            await queue.put(_DONE)

    producer = asyncio.create_task(drain())
    event_id = 0

    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except TimeoutError:
                # An approval can take minutes. A comment line keeps every proxy
                # in between from calling the connection idle.
                yield b": ping\n\n"
                continue

            if item is _DONE:
                return

            event_id += 1

            if isinstance(item, BaseException):
                yield _frame(event_id, "error", _error_of(item, instance))
                return

            yield _frame(event_id, item.kind, item.data)
    finally:
        # The reader went away, or the stream ended. Either way stop pulling on
        # the run: holding a model call open for nobody spends real budget. The
        # checkpoint is already written, so nothing done so far is lost.
        producer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await producer


def _error_of(error: BaseException, instance: str) -> dict[str, Any]:
    if isinstance(error, DomainError):
        return {"code": error.code, "message": error.message}

    # An unknown failure reaches the client as a bare 500-equivalent, and the
    # real message goes to the log only. Without the log it goes nowhere at all.
    logger.exception("run stream failed at %s", instance, exc_info=error)
    problem = problem_from_unknown(error, instance=instance)
    return {"code": problem["code"], "message": problem["title"]}


def _frame(event_id: int, name: str, data: dict[str, Any]) -> bytes:
    body = json.dumps(data, ensure_ascii=False, default=str)
    return f"id: {event_id}\nevent: {name}\ndata: {body}\n\n".encode()


SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # Disables reverse-proxy buffering: without it the stream arrives in one lump.
    "X-Accel-Buffering": "no",
}

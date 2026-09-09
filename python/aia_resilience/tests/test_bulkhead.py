"""The bulkhead: how many calls one key may have in flight.

`aia_resilience` advertised a bulkhead in its own package description and had
none. The two services coming next are Python -- one of them consumes a queue
and has no HTTP port at all -- and both need a way to say "this tenant may not
take every slot".

`InMemoryBulkhead` is what a test and a single replica use. `RedisBulkhead` is
what production uses, because three replicas each allowing twenty is sixty.
"""

from __future__ import annotations

import asyncio

import pytest

from aia_resilience import BulkheadPolicy, ConcurrencyLimitError, InMemoryBulkhead

POLICY = BulkheadPolicy(max_concurrent=2, acquire_timeout_ms=50, lease_ttl_ms=1_000)


def _bulkhead() -> InMemoryBulkhead:
    return InMemoryBulkhead(POLICY)


class TestTheLimit:
    async def test_refuses_once_the_key_is_full(self) -> None:
        bulkhead = _bulkhead()
        await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        # The third waits for `acquire_timeout_ms` and then refuses, rather than
        # queueing forever: a caller holding a socket open is worse than a 429
        # it can act on.
        with pytest.raises(ConcurrencyLimitError):
            await bulkhead.acquire("proj-1")

    async def test_the_refusal_carries_what_the_caller_needs(self) -> None:
        bulkhead = _bulkhead()
        await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        with pytest.raises(ConcurrencyLimitError) as raised:
            await bulkhead.acquire("proj-1")

        assert raised.value.status == 429
        assert raised.value.details["max_concurrent"] == 2
        # A 429 with no retry_after tells the caller to guess.
        assert raised.value.details["retry_after"] == 1

    async def test_one_key_never_blocks_another(self) -> None:
        bulkhead = _bulkhead()
        await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        # The entire point: one project filling its allowance must not make the
        # platform unavailable to everybody else.
        await bulkhead.acquire("proj-2")

    async def test_a_released_slot_is_reusable(self) -> None:
        bulkhead = _bulkhead()
        first = await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        await first.release()

        await bulkhead.acquire("proj-1")

    async def test_releasing_twice_admits_only_one_waiter(self) -> None:
        bulkhead = _bulkhead()
        first = await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        waiting = [asyncio.create_task(bulkhead.acquire("proj-1")) for _ in range(2)]
        await asyncio.sleep(0)

        await first.release()
        await first.release()
        await asyncio.sleep(0)

        # The counter itself is clamped at zero, so a double release looks
        # harmless until you follow the QUEUE: each call wakes a waiter, and two
        # wakeups for one freed slot puts the key over its limit with three
        # leases live against a limit of two.
        admitted = [task for task in waiting if task.done()]
        assert len(admitted) == 1

        for task in waiting:
            task.cancel()


class TestThePerCallOverride:
    """The limit is a governance decision, the policy is only the shape.

    `max_concurrent_requests` is set per project and changes without a deploy,
    so the number cannot live in a constant compiled into the service.
    """

    async def test_the_caller_may_narrow_the_policy(self) -> None:
        bulkhead = _bulkhead()
        await bulkhead.acquire("proj-1", 1)

        with pytest.raises(ConcurrencyLimitError):
            await bulkhead.acquire("proj-1", 1)

    async def test_the_caller_may_widen_it(self) -> None:
        bulkhead = _bulkhead()
        for _ in range(4):
            await bulkhead.acquire("proj-1", 4)

    async def test_the_policy_still_applies_when_nothing_is_passed(self) -> None:
        bulkhead = _bulkhead()
        await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        with pytest.raises(ConcurrencyLimitError):
            await bulkhead.acquire("proj-1")


class TestWaiting:
    async def test_a_waiter_is_admitted_as_soon_as_a_slot_frees(self) -> None:
        bulkhead = _bulkhead()
        first = await bulkhead.acquire("proj-1")
        await bulkhead.acquire("proj-1")

        waiting = asyncio.create_task(bulkhead.acquire("proj-1"))
        await asyncio.sleep(0)
        await first.release()

        # Admitted rather than refused: the timeout exists for a queue that
        # never moves, not for one that moves in time.
        assert await asyncio.wait_for(waiting, 1) is not None

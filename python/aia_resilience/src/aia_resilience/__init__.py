"""Timeout, retry, circuit breaker and bulkhead for the Python services.

Mirrors `@aia/resilience`: the same named policies from reference doc 02 §8, so
that router and agent-runtime behave alike in the face of the same failure.
"""

from __future__ import annotations

import asyncio
import os
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any, Final, Protocol, TypeVar
from uuid import uuid4

from aia_errors import DomainError, ErrorCode

T = TypeVar("T")

DEFAULT_RETRYABLE_STATUSES: Final[frozenset[int]] = frozenset({408, 429, 500, 502, 503, 504})


class CircuitOpenError(DomainError):
    def __init__(self, key: str, reopens_in_ms: float) -> None:
        super().__init__(
            f"Circuit open for {key}",
            code=ErrorCode.CIRCUIT_OPEN,
            status=503,
            details={"target": key, "reopens_in_ms": int(reopens_in_ms)},
            retryable=True,
        )


class UpstreamTimeoutError(DomainError):
    def __init__(self, target: str, timeout_ms: int) -> None:
        super().__init__(
            f"Timed out calling {target}",
            code=ErrorCode.UPSTREAM_TIMEOUT,
            status=504,
            details={"target": target, "timeout_ms": timeout_ms},
            retryable=True,
        )


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """`max_attempts` counts ADDITIONAL attempts: 2 means up to 3 calls."""

    max_attempts: int = 2
    base_delay_ms: int = 500
    max_delay_ms: int = 8_000
    honor_retry_after: bool = True


@dataclass(frozen=True, slots=True)
class CircuitBreakerPolicy:
    failure_threshold: int = 5
    open_ms: int = 30_000
    success_threshold: int = 2


@dataclass(frozen=True, slots=True)
class TimeoutPolicy:
    """Two budgets, because they fail differently.

    `connect_ms` is time to reach the other end; `total_ms` is time for the
    whole call. A provider that is DOWN fails the first in a second, while a
    provider that is merely slow needs the second to be generous. Collapsing
    them into one number -- which this package used to do -- means either
    declaring a dead dependency healthy for sixty seconds, or cutting off a
    model that was about to answer.

    httpx takes both natively, which is why the shape is worth carrying.
    """

    connect_ms: int
    total_ms: int


@dataclass(frozen=True, slots=True)
class BulkheadPolicy:
    """Concurrent calls allowed per key, normally the project."""

    max_concurrent: int
    acquire_timeout_ms: int
    #: Slot lifetime, so a dead process cannot wedge the semaphore.
    lease_ttl_ms: int | None = None


@dataclass(frozen=True, slots=True)
class ResiliencePolicy:
    name: str
    timeout: TimeoutPolicy | None = None
    retry: RetryPolicy | None = None
    circuit_breaker: CircuitBreakerPolicy | None = None
    bulkhead: BulkheadPolicy | None = None

    def with_total_timeout(self, total_ms: int) -> ResiliencePolicy:
        """The same policy with a longer ceiling, and the same time to connect.

        A deliberate deviation for a caller nobody is waiting on -- an offline
        batch, say -- expressed as one. `replace(policy, timeout=...)` would
        rebuild the whole timeout and quietly reset `connect_ms` to whatever the
        caller happened to type, so a provider that is DOWN would stop failing
        in a second and start failing in five minutes.
        """
        if self.timeout is None:
            raise ValueError(f"{self.name} declares no timeout to extend")
        return replace(self, timeout=replace(self.timeout, total_ms=total_ms))


class Policies:
    """The named policies from the table in reference doc 02 §8.

    Every value here matches `POLICIES` in `packages/resilience`, and a test
    asserts it. They used to differ quietly: this side had four of the eight,
    `INTERNAL` opened its circuit for thirty seconds where TypeScript used ten,
    and `GUARDRAIL` had no circuit breaker at all -- so the same named policy
    meant two different things depending on which language made the call.
    """

    #: Non-streaming inference: 3 s to connect, 60 s total, up to 2 retries.
    INFERENCE: Final = ResiliencePolicy(
        "inference",
        timeout=TimeoutPolicy(connect_ms=3_000, total_ms=60_000),
        retry=RetryPolicy(),
        circuit_breaker=CircuitBreakerPolicy(),
        bulkhead=BulkheadPolicy(max_concurrent=20, acquire_timeout_ms=2_000, lease_ttl_ms=90_000),
    )

    #: Streaming: 10 s to the first token. No retry after it -- the caller has
    #: already seen part of the answer, and the failure becomes
    #: `stream_interrupted`.
    INFERENCE_STREAMING: Final = ResiliencePolicy(
        "inference_streaming",
        timeout=TimeoutPolicy(connect_ms=3_000, total_ms=10_000),
        retry=RetryPolicy(max_attempts=1, base_delay_ms=300, max_delay_ms=3_000),
        circuit_breaker=CircuitBreakerPolicy(),
        bulkhead=BulkheadPolicy(max_concurrent=20, acquire_timeout_ms=2_000, lease_ttl_ms=300_000),
    )

    #: A LOCAL model reads itself from disk on the first call. Failing for that
    #: reason would break precisely the zero-cost path.
    INFERENCE_STREAMING_LOCAL: Final = ResiliencePolicy(
        "inference_streaming_local",
        timeout=TimeoutPolicy(connect_ms=2_000, total_ms=120_000),
        retry=RetryPolicy(max_attempts=0, base_delay_ms=0, max_delay_ms=0),
        circuit_breaker=CircuitBreakerPolicy(),
    )

    INFERENCE_LOCAL: Final = ResiliencePolicy(
        "inference_local",
        timeout=TimeoutPolicy(connect_ms=2_000, total_ms=180_000),
        retry=RetryPolicy(max_attempts=1, base_delay_ms=500, max_delay_ms=2_000),
        circuit_breaker=CircuitBreakerPolicy(),
    )

    #: Batched embeddings: 30 s per batch, up to 3 retries.
    EMBEDDINGS: Final = ResiliencePolicy(
        "embeddings",
        timeout=TimeoutPolicy(connect_ms=3_000, total_ms=30_000),
        retry=RetryPolicy(max_attempts=3, base_delay_ms=500, max_delay_ms=10_000),
        circuit_breaker=CircuitBreakerPolicy(),
    )

    #: Internal call (governance, registry). The fallback is the caller's own
    #: cache with a TTL, which is why the circuit reopens quickly.
    INTERNAL: Final = ResiliencePolicy(
        "internal",
        timeout=TimeoutPolicy(connect_ms=1_000, total_ms=2_000),
        retry=RetryPolicy(max_attempts=1, base_delay_ms=100, max_delay_ms=500),
        circuit_breaker=CircuitBreakerPolicy(failure_threshold=5, open_ms=10_000),
    )

    #: A tool does not retry: the action may not be idempotent (doc 02 §8). The
    #: error goes back to the agent as an observation.
    TOOL: Final = ResiliencePolicy(
        "tool",
        timeout=TimeoutPolicy(connect_ms=2_000, total_ms=20_000),
        circuit_breaker=CircuitBreakerPolicy(
            failure_threshold=3, open_ms=60_000, success_threshold=1
        ),
        bulkhead=BulkheadPolicy(max_concurrent=5, acquire_timeout_ms=1_000, lease_ttl_ms=30_000),
    )

    #: Guardrails: fast and mandatory. Failing open is a security decision, and
    #: it belongs to the caller rather than to a timeout (ADR-026).
    GUARDRAIL: Final = ResiliencePolicy(
        "guardrail",
        timeout=TimeoutPolicy(connect_ms=500, total_ms=3_000),
        retry=RetryPolicy(max_attempts=1, base_delay_ms=100, max_delay_ms=400),
        circuit_breaker=CircuitBreakerPolicy(
            failure_threshold=10, open_ms=15_000, success_threshold=3
        ),
    )


def status_of(error: BaseException) -> int | None:
    status = getattr(error, "status", None)
    return status if isinstance(status, int) else None


def retry_after_ms_of(error: BaseException) -> float | None:
    value: object = getattr(error, "retry_after_ms", None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def is_retryable(error: BaseException, policy: RetryPolicy) -> bool:
    _ = policy
    status = status_of(error)
    # No status: a network failure. Worth another attempt.
    return status is None or status in DEFAULT_RETRYABLE_STATUSES


def next_delay_ms(attempt: int, policy: RetryPolicy, error: BaseException) -> float:
    """Exponential backoff with full jitter, honouring `Retry-After`."""
    if policy.honor_retry_after:
        retry_after = retry_after_ms_of(error)
        if retry_after is not None and retry_after > 0:
            return min(retry_after, policy.max_delay_ms)
    # A shift rather than `2**attempt`: doubling bitwise keeps the integer type.
    ceiling = min(policy.base_delay_ms << attempt, policy.max_delay_ms)
    return random.random() * ceiling  # noqa: S311 - jitter, not cryptography


@dataclass(slots=True)
class _Circuit:
    state: str = "closed"
    consecutive_failures: int = 0
    half_open_successes: int = 0
    opens_until: float = 0.0


@dataclass(slots=True)
class CircuitBreaker:
    """Per key and per process.

    State shared across replicas would need a network round trip on the critical
    path, which costs more than it saves.
    """

    policy: CircuitBreakerPolicy
    _circuits: dict[str, _Circuit] = field(default_factory=dict, init=False)

    def _entry(self, key: str) -> _Circuit:
        return self._circuits.setdefault(key, _Circuit())

    def state_of(self, key: str) -> str:
        return self._entry(key).state

    def ensure_closed(self, key: str, now: float | None = None) -> None:
        entry = self._entry(key)
        if entry.state != "open":
            return
        moment = now if now is not None else time.monotonic() * 1000
        remaining = entry.opens_until - moment
        if remaining > 0:
            raise CircuitOpenError(key, remaining)
        entry.state = "half-open"
        entry.half_open_successes = 0

    def record_success(self, key: str) -> None:
        entry = self._entry(key)
        entry.consecutive_failures = 0
        if entry.state == "half-open":
            entry.half_open_successes += 1
            if entry.half_open_successes >= self.policy.success_threshold:
                entry.state = "closed"
                entry.half_open_successes = 0
                entry.opens_until = 0.0

    def record_failure(self, key: str, error: BaseException | None = None) -> None:
        entry = self._entry(key)
        entry.consecutive_failures += 1
        entry.half_open_successes = 0

        should_open = (
            entry.state == "half-open"
            or entry.consecutive_failures >= self.policy.failure_threshold
        )
        if not should_open:
            return

        # The dependency knows better than we do when it will be ready.
        retry_after = retry_after_ms_of(error) if error is not None else None
        entry.opens_until = (time.monotonic() * 1000) + (retry_after or self.policy.open_ms)
        entry.state = "open"


class ConcurrencyLimitError(DomainError):
    def __init__(self, key: str, max_concurrent: int) -> None:
        super().__init__(
            f"Reached the limit of {max_concurrent} concurrent calls",
            code=ErrorCode.CONCURRENCY_LIMIT,
            status=429,
            details={"key": key, "max_concurrent": max_concurrent, "retry_after": 1},
        )


class BulkheadLease(Protocol):
    """A slot taken from the semaphore. Always released in a `finally`."""

    async def release(self) -> None: ...


class Bulkhead(Protocol):
    """Caps concurrency per key, so one project cannot consume every slot.

    `max_concurrent` overrides the policy's default for this key. It exists
    because the limit is a GOVERNANCE decision -- `max_concurrent_requests` is
    set per project and changes without a deploy -- while the policy carries the
    shape that does not vary: how long to wait, and how long a lease may outlive
    the process holding it.
    """

    async def acquire(self, key: str, max_concurrent: int | None = None) -> BulkheadLease: ...


@dataclass(slots=True)
class _InMemoryLease:
    _release: Callable[[], None]
    _released: bool = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._release()


@dataclass(slots=True)
class InMemoryBulkhead:
    """Per-process semaphore. Enough for a single replica, or for a test.

    NOT enough for the real thing: three replicas each allowing twenty is sixty,
    and the limit is meant to be what a project may run at once.
    """

    policy: BulkheadPolicy
    _in_flight: dict[str, int] = field(default_factory=dict)
    _waiting: dict[str, list[asyncio.Future[None]]] = field(default_factory=dict)

    async def acquire(self, key: str, max_concurrent: int | None = None) -> BulkheadLease:
        limit = self.policy.max_concurrent if max_concurrent is None else max_concurrent

        if self._in_flight.get(key, 0) >= limit:
            await self._wait_for_slot(key, limit)

        self._in_flight[key] = self._in_flight.get(key, 0) + 1
        return _InMemoryLease(lambda: self._release(key))

    async def _wait_for_slot(self, key: str, limit: int) -> None:
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        queue = self._waiting.setdefault(key, [])
        queue.append(waiter)
        try:
            await asyncio.wait_for(waiter, self.policy.acquire_timeout_ms / 1000)
        except TimeoutError as error:
            if waiter in queue:
                queue.remove(waiter)
            raise ConcurrencyLimitError(key, limit) from error

    def _release(self, key: str) -> None:
        self._in_flight[key] = max(0, self._in_flight.get(key, 1) - 1)
        queue = self._waiting.get(key)
        while queue:
            waiter = queue.pop(0)
            if not waiter.done():
                waiter.set_result(None)
                return


class RedisLike(Protocol):
    """The minimal Redis surface the bulkhead needs. Avoids coupling to a client."""

    async def eval(self, script: str, numkeys: int, *args: str | int) -> Any: ...


@dataclass(slots=True)
class _RedisLease:
    _redis: RedisLike
    _key: str
    _member: str
    _released: bool = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await self._redis.eval(_RELEASE_SCRIPT, 1, self._key, self._member)


#: Each slot is a sorted-set member scored with its expiry, so a process that
#: dies without releasing does not wedge the semaphore forever.
_ACQUIRE_SCRIPT = """
    local key, now, ttl, limit, member = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]),
                                         tonumber(ARGV[3]), ARGV[4]
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
    if redis.call('ZCARD', key) >= limit then return 0 end
    redis.call('ZADD', key, now + ttl, member)
    redis.call('PEXPIRE', key, ttl)
    return 1
"""

_RELEASE_SCRIPT = "return redis.call('ZREM', KEYS[1], ARGV[1])"


@dataclass(slots=True)
class RedisBulkhead:
    """Distributed semaphore: the limit applies across every replica."""

    redis: RedisLike
    policy: BulkheadPolicy
    key_prefix: str = "aia:bulkhead"

    async def acquire(self, key: str, max_concurrent: int | None = None) -> BulkheadLease:
        limit = self.policy.max_concurrent if max_concurrent is None else max_concurrent
        redis_key = f"{self.key_prefix}:{key}"
        ttl = self.policy.lease_ttl_ms or 60_000
        deadline = time.monotonic() + self.policy.acquire_timeout_ms / 1000

        while True:
            now_ms = int(time.time() * 1000)
            member = f"{os.getpid()}-{now_ms}-{uuid4().hex[:8]}"
            acquired = await self.redis.eval(
                _ACQUIRE_SCRIPT, 1, redis_key, now_ms, ttl, limit, member
            )

            if acquired == 1:
                return _RedisLease(self.redis, redis_key, member)

            if time.monotonic() >= deadline:
                raise ConcurrencyLimitError(key, limit)
            # Polling rather than a Redis notification: the wait is bounded by
            # `acquire_timeout_ms`, and a keyspace subscription per caller costs
            # more than the few polls that fit inside it.
            await asyncio.sleep(0.05)


@dataclass(slots=True)
class ResilienceExecutor:
    """Layers, outermost first: retry -> circuit breaker -> timeout."""

    policy: ResiliencePolicy
    _breaker: CircuitBreaker | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        if self.policy.circuit_breaker is not None:
            self._breaker = CircuitBreaker(self.policy.circuit_breaker)

    async def execute(self, operation: Callable[[], Awaitable[T]], *, key: str | None = None) -> T:
        target = key or self.policy.name
        retry = self.policy.retry
        attempts = 0 if retry is None else retry.max_attempts

        last_error: BaseException | None = None
        for attempt in range(attempts + 1):
            try:
                return await self._guarded(operation, target)
            except BaseException as error:
                last_error = error
                exhausted = attempt == attempts
                if exhausted or retry is None or not is_retryable(error, retry):
                    raise
                await asyncio.sleep(next_delay_ms(attempt, retry, error) / 1000)

        assert last_error is not None
        raise last_error

    async def _guarded(self, operation: Callable[[], Awaitable[T]], key: str) -> T:
        if self._breaker is not None:
            self._breaker.ensure_closed(key)
        try:
            timeout = self.policy.timeout
            if timeout is None:
                result = await operation()
            else:
                # `total_ms` is the budget for the whole call. `connect_ms` is
                # the client's business -- httpx takes it directly -- because
                # only the client knows when a connection was established.
                try:
                    result = await asyncio.wait_for(operation(), timeout.total_ms / 1000)
                except TimeoutError as error:
                    raise UpstreamTimeoutError(key, timeout.total_ms) from error
        except BaseException as error:
            if self._breaker is not None:
                self._breaker.record_failure(key, error)
            raise
        if self._breaker is not None:
            self._breaker.record_success(key)
        return result


__all__: list[str] = [
    "Bulkhead",
    "BulkheadLease",
    "BulkheadPolicy",
    "CircuitBreaker",
    "CircuitBreakerPolicy",
    "CircuitOpenError",
    "ConcurrencyLimitError",
    "InMemoryBulkhead",
    "Policies",
    "RedisBulkhead",
    "ResilienceExecutor",
    "ResiliencePolicy",
    "RetryPolicy",
    "TimeoutPolicy",
    "UpstreamTimeoutError",
    "is_retryable",
    "next_delay_ms",
]

_ = Any

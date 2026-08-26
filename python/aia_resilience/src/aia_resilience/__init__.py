"""Timeout, retry, circuit breaker e bulkhead para os servicos Python.

Espelha o `@aia/resilience`: as mesmas politicas nomeadas do doc 02, secao 8,
para que router e agent-runtime se comportem igual diante da mesma falha.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Final, TypeVar

from aia_errors import DomainError, ErrorCode

T = TypeVar("T")

DEFAULT_RETRYABLE_STATUSES: Final[frozenset[int]] = frozenset({408, 429, 500, 502, 503, 504})


class CircuitOpenError(DomainError):
    def __init__(self, key: str, reopens_in_ms: float) -> None:
        super().__init__(
            f"Circuito aberto para {key}",
            code=ErrorCode.CIRCUIT_OPEN,
            status=503,
            details={"target": key, "reopens_in_ms": int(reopens_in_ms)},
            retryable=True,
        )


class UpstreamTimeoutError(DomainError):
    def __init__(self, target: str, timeout_ms: int) -> None:
        super().__init__(
            f"Tempo esgotado ao chamar {target}",
            code=ErrorCode.UPSTREAM_TIMEOUT,
            status=504,
            details={"target": target, "timeout_ms": timeout_ms},
            retryable=True,
        )


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """`max_attempts` conta tentativas ADICIONAIS: 2 significa ate 3 chamadas."""

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
class ResiliencePolicy:
    name: str
    timeout_ms: int | None = None
    retry: RetryPolicy | None = None
    circuit_breaker: CircuitBreakerPolicy | None = None


class Policies:
    """Politicas da tabela do doc 02, secao 8."""

    INFERENCE: Final = ResiliencePolicy(
        "inference", timeout_ms=60_000, retry=RetryPolicy(), circuit_breaker=CircuitBreakerPolicy()
    )
    INTERNAL: Final = ResiliencePolicy(
        "internal",
        timeout_ms=2_000,
        retry=RetryPolicy(max_attempts=1, base_delay_ms=100, max_delay_ms=500),
        circuit_breaker=CircuitBreakerPolicy(),
    )
    # Tool nao retenta: a acao pode nao ser idempotente (doc 02, secao 8).
    TOOL: Final = ResiliencePolicy(
        "tool",
        timeout_ms=20_000,
        circuit_breaker=CircuitBreakerPolicy(
            failure_threshold=3, open_ms=60_000, success_threshold=1
        ),
    )
    GUARDRAIL: Final = ResiliencePolicy(
        "guardrail",
        timeout_ms=3_000,
        retry=RetryPolicy(max_attempts=1, base_delay_ms=100, max_delay_ms=400),
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
    # Sem status: falha de rede. Vale tentar de novo.
    return status is None or status in DEFAULT_RETRYABLE_STATUSES


def next_delay_ms(attempt: int, policy: RetryPolicy, error: BaseException) -> float:
    """Backoff exponencial com full jitter, respeitando `Retry-After`."""
    if policy.honor_retry_after:
        retry_after = retry_after_ms_of(error)
        if retry_after is not None and retry_after > 0:
            return min(retry_after, policy.max_delay_ms)
    # Deslocamento em vez de `2**attempt`: dobrar por bit mantem o tipo inteiro.
    ceiling = min(policy.base_delay_ms << attempt, policy.max_delay_ms)
    return random.random() * ceiling  # noqa: S311 - jitter, nao criptografia


@dataclass(slots=True)
class _Circuit:
    state: str = "closed"
    consecutive_failures: int = 0
    half_open_successes: int = 0
    opens_until: float = 0.0


@dataclass(slots=True)
class CircuitBreaker:
    """Por chave e por processo.

    Estado compartilhado entre replicas exigiria uma ida a rede no caminho
    critico, o que custa mais do que economiza.
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

        # A dependencia sabe melhor que nos quando estara pronta.
        retry_after = retry_after_ms_of(error) if error is not None else None
        entry.opens_until = (time.monotonic() * 1000) + (retry_after or self.policy.open_ms)
        entry.state = "open"


@dataclass(slots=True)
class ResilienceExecutor:
    """Camadas, de fora para dentro: retry -> circuit breaker -> timeout."""

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
            if self.policy.timeout_ms is None:
                result = await operation()
            else:
                try:
                    result = await asyncio.wait_for(operation(), self.policy.timeout_ms / 1000)
                except TimeoutError as error:
                    raise UpstreamTimeoutError(key, self.policy.timeout_ms) from error
        except BaseException as error:
            if self._breaker is not None:
                self._breaker.record_failure(key, error)
            raise
        if self._breaker is not None:
            self._breaker.record_success(key)
        return result


__all__: list[str] = [
    "CircuitBreaker",
    "CircuitBreakerPolicy",
    "CircuitOpenError",
    "Policies",
    "ResilienceExecutor",
    "ResiliencePolicy",
    "RetryPolicy",
    "UpstreamTimeoutError",
    "is_retryable",
    "next_delay_ms",
]

_ = Any

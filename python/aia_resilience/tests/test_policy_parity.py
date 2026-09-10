"""The named policies mean the same thing in both languages.

They did not. This side had four of the eight; `INTERNAL` held its circuit open
for thirty seconds where TypeScript used ten; `GUARDRAIL` had no circuit breaker
at all; and the timeout was one number where TypeScript carries two. So
`Policies.INTERNAL` named one behaviour in the router and another in
agent-runtime, and nothing compared them.

The TypeScript SOURCE is parsed rather than its build output: `dist/` is
gitignored, and a test that skips when a directory is missing is a test that
passes for the wrong reason. If `policies.ts` is ever restructured this parser
fails loudly, which is the correct outcome -- it means the comparison stopped
being valid.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from aia_resilience import Policies

ROOT = Path(__file__).resolve().parents[3]
POLICIES_TS = ROOT / "packages/resilience/src/policies.ts"

EXPECTED_NAMES = {
    "INFERENCE",
    "INFERENCE_STREAMING",
    "INFERENCE_STREAMING_LOCAL",
    "INFERENCE_LOCAL",
    "EMBEDDINGS",
    "INTERNAL",
    "TOOL",
    "GUARDRAIL",
}


def _blocks() -> dict[str, str]:
    """Each `NAME: { ... }` entry, by name."""
    source = POLICIES_TS.read_text()
    found: dict[str, str] = {}
    for match in re.finditer(r"^  ([A-Z_]+): \{$", source, re.M):
        start = match.end()
        end = source.index("\n  },", start)
        found[match.group(1)] = source[start:end]
    return found


def _number(block: str, field: str) -> int | None:
    match = re.search(rf"\b{field}:\s*([\d_]+)", block)
    return None if match is None else int(match.group(1).replace("_", ""))


@pytest.fixture(scope="module")
def typescript() -> dict[str, str]:
    blocks = _blocks()
    # If this fails the parser has stopped understanding the file, and every
    # comparison below would silently compare nothing.
    assert set(blocks) == EXPECTED_NAMES, f"parsed {sorted(blocks)}"
    return blocks


def _python(name: str) -> Any:
    return getattr(Policies, name)


class TestEveryPolicyExists:
    def test_python_declares_the_same_eight(self) -> None:
        declared = {name for name in dir(Policies) if name.isupper()}
        assert declared == EXPECTED_NAMES

    @pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
    def test_the_name_field_matches_the_key(self, name: str, typescript: dict[str, str]) -> None:
        expected = re.search(r"name: '([a-z_]+)'", typescript[name])
        assert expected is not None
        assert _python(name).name == expected.group(1)


class TestTimeouts:
    """Both budgets, because they fail differently.

    `connect_ms` is time to reach the other end and `total_ms` is time for the
    whole call. Python used to carry one number, so a dependency that was DOWN
    and one that was merely SLOW were given the same budget.
    """

    @pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
    def test_connect_and_total_match(self, name: str, typescript: dict[str, str]) -> None:
        block = typescript[name]
        timeout = _python(name).timeout

        assert timeout is not None, f"{name} has no timeout in Python"
        assert timeout.connect_ms == _number(block, "connectMs")
        assert timeout.total_ms == _number(block, "totalMs")


class TestRetries:
    @pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
    def test_retry_matches_or_is_absent_in_both(
        self, name: str, typescript: dict[str, str]
    ) -> None:
        block = typescript[name]
        retry = _python(name).retry
        max_attempts = _number(block, "maxAttempts")

        if max_attempts is None:
            # TOOL is the case: a tool action may not be idempotent, so retrying
            # it is a decision nobody made (doc 02 §8).
            assert retry is None, f"{name} retries in Python and not in TypeScript"
            return

        assert retry is not None, f"{name} retries in TypeScript and not in Python"
        assert retry.max_attempts == max_attempts
        assert retry.base_delay_ms == _number(block, "baseDelayMs")
        assert retry.max_delay_ms == _number(block, "maxDelayMs")


class TestCircuitBreakers:
    @pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
    def test_breaker_matches_or_is_absent_in_both(
        self, name: str, typescript: dict[str, str]
    ) -> None:
        block = typescript[name]
        breaker = _python(name).circuit_breaker
        threshold = _number(block, "failureThreshold")

        if threshold is None:
            assert breaker is None, f"{name} breaks in Python and not in TypeScript"
            return

        assert breaker is not None, f"{name} breaks in TypeScript and not in Python"
        assert breaker.failure_threshold == threshold
        assert breaker.open_ms == _number(block, "openMs")
        assert breaker.success_threshold == _number(block, "successThreshold")


class TestBulkheads:
    @pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
    def test_bulkhead_matches_or_is_absent_in_both(
        self, name: str, typescript: dict[str, str]
    ) -> None:
        block = typescript[name]
        bulkhead = _python(name).bulkhead
        max_concurrent = _number(block, "maxConcurrent")

        if max_concurrent is None:
            assert bulkhead is None, f"{name} caps concurrency in Python and not in TypeScript"
            return

        assert bulkhead is not None, f"{name} caps concurrency in TypeScript and not in Python"
        assert bulkhead.max_concurrent == max_concurrent
        assert bulkhead.acquire_timeout_ms == _number(block, "acquireTimeoutMs")
        assert bulkhead.lease_ttl_ms == _number(block, "leaseTtlMs")

"""Runs the red team datasets against the heuristics.

An adversarial dataset nobody runs is documentation, not defence. This test
makes `evals/redteam/*.jsonl` count in CI: a known attack that starts slipping
through, or a legitimate use that starts being blocked, fails the PR.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from guardrails.application.dto import InspectCommand
from guardrails.application.use_cases.inspect_content import InspectContent
from guardrails.domain.entities import Decision
from guardrails.domain.injection import InjectionHeuristics
from guardrails.infrastructure.regex_detector import RegexPiiDetector

REDTEAM_DIR = Path(__file__).resolve().parents[3] / "evals" / "redteam"


def _load(filename: str) -> list[dict[str, Any]]:
    path = REDTEAM_DIR / filename
    if not path.exists():  # pragma: no cover - guards against moving the directory
        pytest.skip(f"missing dataset: {path}")
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


@pytest.fixture(scope="module")
def inspect() -> InspectContent:
    return InspectContent(detector=RegexPiiDetector(), heuristics=InjectionHeuristics())


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [f"{case['id']}-{case['category']}" for case in cases]


ATTACKS = _load("prompt-injection.jsonl")
LEGITIMATE = _load("false-positive.jsonl")


@pytest.mark.parametrize(
    "case",
    [c for c in ATTACKS if c["expected"] == "block"],
    ids=_ids([c for c in ATTACKS if c["expected"] == "block"]),
)
def test_a_known_attack_is_blocked(inspect: InspectContent, case: dict[str, Any]) -> None:
    result = inspect.execute(InspectCommand(text=case["input"], project_id="platform-ci"))

    assert result.decision is Decision.BLOCK, (
        f"{case['id']} ({case['reference']}) should have been blocked. "
        f"Signals detected: {[s.rule for s in result.injection_signals]}"
    )


@pytest.mark.parametrize(
    "case",
    [c for c in ATTACKS if c["expected"] == "flag"],
    ids=_ids([c for c in ATTACKS if c["expected"] == "flag"]),
)
def test_a_weak_signal_is_detected_but_does_not_block(
    inspect: InspectContent, case: dict[str, Any]
) -> None:
    result = inspect.execute(InspectCommand(text=case["input"], project_id="platform-ci"))

    # Detect and record without blocking: the signal goes to the trace and to
    # the alert, and the operator decides. Blocking a pattern that has a
    # legitimate reading (an internal webhook, a pasted log) would produce a
    # false positive.
    assert result.injection_suspected, f"{case['id']} should at least raise a signal"
    assert result.decision is not Decision.BLOCK, (
        f"{case['id']} is a lone weak signal ({case['note']}) and should not block"
    )


@pytest.mark.parametrize("case", LEGITIMATE, ids=_ids(LEGITIMATE))
def test_legitimate_use_is_not_blocked(inspect: InspectContent, case: dict[str, Any]) -> None:
    result = inspect.execute(InspectCommand(text=case["input"], project_id="platform-ci"))

    # Blocking legitimate work makes the team switch the guardrail off, and a
    # guardrail that is off protects nothing. This test matters as much as the
    # one above.
    assert result.decision is not Decision.BLOCK, (
        f"{case['id']} is legitimate use ({case['note']}) and was blocked by "
        f"{[s.rule for s in result.injection_signals]}"
    )

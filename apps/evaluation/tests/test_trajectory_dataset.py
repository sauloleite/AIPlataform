"""The trajectory gate: recorded runs, scored on every pull request.

The pattern is `apps/guardrails/tests/test_redteam_dataset.py`, and it is the
pattern for the same reason: these cases cost nothing. A recorded run needs no
model, no platform and no network, so the checks run in `test-unit` on every
change — while groundedness, which needs a judge, cannot and runs nightly.

Both directions are here. Three fixtures are runs that should pass, and one is a
run that genuinely loops and blows its step budget: the checks must FAIL that
one. A suite where every case passes proves only that the evaluators return
true.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from evaluation.domain.trajectory import (
    Verdict,
    arguments_contain,
    called_in_order,
    called_no_forbidden_tool,
    called_the_expected_tools,
    did_not_loop,
    recovered_from_failure,
    within_step_budget,
)

TRAJECTORIES = Path(__file__).resolve().parents[3] / "evals/trajectories"


def cases() -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    expectations = json.loads((TRAJECTORIES / "expectations.json").read_text())
    loaded = []
    for case in expectations["cases"]:
        run = json.loads((TRAJECTORIES / case["run"]).read_text())
        loaded.append((case["run"], case["expect"], run))
    return loaded


def checks_for(expect: dict[str, Any], run: dict[str, Any]) -> dict[str, Verdict]:
    """Every check the case declares, by name. A case declares what it means."""
    found: dict[str, Verdict] = {}
    if "tools" in expect:
        found["tools"] = called_the_expected_tools(run, expect["tools"])
    if "forbidden_tools" in expect:
        found["forbidden_tools"] = called_no_forbidden_tool(run, expect["forbidden_tools"])
    if "order" in expect:
        found["order"] = called_in_order(run, expect["order"])
    if "max_steps" in expect:
        found["max_steps"] = within_step_budget(run, expect["max_steps"])
    if expect.get("no_loop"):
        found["no_loop"] = did_not_loop(run)
    if expect.get("recovered"):
        found["recovered"] = recovered_from_failure(run)
    for tool, arguments in (expect.get("arguments") or {}).items():
        found[f"arguments:{tool}"] = arguments_contain(run, tool, arguments)
    return found


@pytest.mark.parametrize(("name", "expect", "run"), cases(), ids=lambda value: str(value)[:40])
def test_a_recorded_run_meets_what_it_declares(
    name: str, expect: dict[str, Any], run: dict[str, Any]
) -> None:
    should_fail = set(expect.get("expected_failures") or [])
    verdicts = checks_for(expect, run)

    for check, verdict in verdicts.items():
        if check in should_fail:
            assert not verdict.passed, (
                f"{name}: {check} was supposed to catch this run and did not — "
                f"it said {verdict.reason!r}"
            )
        else:
            assert verdict.passed, f"{name}: {check} failed — {verdict.reason}"

    missing = should_fail - set(verdicts)
    assert not missing, f"{name} expects {missing} to fail, but no such check ran"


@pytest.mark.parametrize(("name", "expect", "run"), cases(), ids=lambda value: str(value)[:40])
def test_a_recorded_run_ended_the_way_it_says(
    name: str, expect: dict[str, Any], run: dict[str, Any]
) -> None:
    assert run["status"] == expect["status"], name


def test_the_fixtures_are_actually_there() -> None:
    # A parametrised test over an empty list passes, reports nothing, and looks
    # exactly like a gate. The red-team suite guards itself the same way.
    assert len(cases()) >= 4

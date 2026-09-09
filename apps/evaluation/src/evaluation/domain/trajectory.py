"""Scoring an agent RUN rather than an answer.

The rest of this service measures one chat completion against a reference. An
agent run is a different object: what it chose to do, in what order, with what
arguments, and whether it got anywhere. A run that produces a perfect sentence
having called the wrong tool three times is not a good run, and no evaluator
here could see that.

Everything below is pure, over the shape `GET /v1/runs/{runId}` returns. That is
deliberate and it is what makes this gate affordable: a recorded run needs no
model, no platform and no network, so these can run on every pull request the
way the red-team cases already do -- while groundedness, which needs a judge,
cannot.

Reading the run through the CONTRACT and not through agent-runtime's domain is
the other half: no service imports another's domain (CLAUDE.md), and a shape
that came off the real route cannot drift from it unnoticed.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ToolInvocation:
    """One call the model made, as the transcript records it."""

    id: str
    name: str
    arguments: dict[str, Any]
    #: What came back, or None when the transcript holds no answer for it.
    result: dict[str, Any] | None = None

    @property
    def failed(self) -> bool:
        return self.result is not None and self.result.get("status") in {"failed", "denied"}

    @property
    def refused(self) -> bool:
        """The platform declined it: unknown tool, not allowed, blocked."""
        return self.result is not None and self.result.get("status") in {
            "unknown_tool",
            "not_allowed",
            "blocked",
        }


@dataclass(frozen=True, slots=True)
class Verdict:
    """Binary, with the reason attached.

    A trajectory evaluator that returned 0.7 would be inventing a scale: a run
    either called the tool it was supposed to or it did not. The reason travels
    with the verdict because "false" on its own sends somebody to read a
    transcript to find out what it meant.
    """

    passed: bool
    reason: str


def invocations(run: dict[str, Any]) -> list[ToolInvocation]:
    """Every call in the transcript, in order, paired with its result.

    Paired by `tool_call_id`, which is the only link the transcript has -- and
    the reason the contract's `TranscriptToolCall` documents that field as the
    one a `tool` message answers.
    """
    messages: Sequence[dict[str, Any]] = run.get("messages") or []
    results: dict[str, dict[str, Any]] = {}

    for message in messages:
        if message.get("role") != "tool":
            continue
        call_id = str(message.get("tool_call_id") or "")
        results[call_id] = _as_object(message.get("content"))

    found: list[ToolInvocation] = []
    for message in messages:
        for call in message.get("tool_calls") or []:
            call_id = str(call.get("id") or "")
            function = call.get("function") or {}
            found.append(
                ToolInvocation(
                    id=call_id,
                    name=str(function.get("name") or ""),
                    # The providers encode arguments as a STRING, and the
                    # transcript keeps them unchanged. An evaluator comparing
                    # them as text would fail on whitespace nobody chose.
                    arguments=_as_object(function.get("arguments")),
                    result=results.get(call_id),
                )
            )
    return found


def _as_object(raw: object) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        # Not JSON: a tool that answered plain text. Not an error -- the
        # transcript is allowed to hold it -- but there are no fields to match.
        return {}
    return parsed if isinstance(parsed, dict) else {}


def called_the_expected_tools(run: dict[str, Any], expected: Sequence[str]) -> Verdict:
    """Tool selection: every named tool was actually called."""
    used = {call.name for call in invocations(run)}
    missing = [name for name in expected if name not in used]
    if missing:
        return Verdict(False, f"never called: {', '.join(missing)}")
    return Verdict(True, f"called {', '.join(sorted(used)) or 'nothing'}")


def called_no_forbidden_tool(run: dict[str, Any], forbidden: Sequence[str]) -> Verdict:
    """The other half of selection, and the half that matters for safety.

    A run that answers correctly having also called something it should not is
    the failure worth catching: the answer looks fine and the side effect
    already happened.
    """
    used = {call.name for call in invocations(run)}
    trespassed = sorted(used.intersection(forbidden))
    if trespassed:
        return Verdict(False, f"called what it must not: {', '.join(trespassed)}")
    return Verdict(True, "called nothing it was forbidden")


def called_in_order(run: dict[str, Any], order: Sequence[str]) -> Verdict:
    """The expected names appear in that relative order.

    A SUBSEQUENCE, not an exact list: a run allowed to search twice before
    answering has not done anything wrong, and an evaluator that demanded an
    exact sequence would fail every run that retried.
    """
    remaining = list(order)
    for call in invocations(run):
        if remaining and call.name == remaining[0]:
            remaining.pop(0)
    if remaining:
        return Verdict(False, f"never reached, in order: {', '.join(remaining)}")
    return Verdict(True, f"called in the order {' -> '.join(order)}")


def arguments_contain(run: dict[str, Any], tool: str, expected: dict[str, str]) -> Verdict:
    """Argument correctness, as a substring match per field.

    Substring and case-insensitive because an argument is written by a model:
    demanding an exact string would measure the model's phrasing rather than
    whether it passed the right thing.
    """
    calls = [call for call in invocations(run) if call.name == tool]
    if not calls:
        return Verdict(False, f"{tool} was never called, so its arguments cannot match")

    for call in calls:
        if all(
            str(needle).lower() in str(call.arguments.get(field, "")).lower()
            for field, needle in expected.items()
        ):
            return Verdict(True, f"{tool} was called with {call.arguments}")

    return Verdict(
        False, f"no call to {tool} carried {expected}; saw {[c.arguments for c in calls]}"
    )


def within_step_budget(run: dict[str, Any], maximum: int) -> Verdict:
    """Steps against a ceiling.

    The budget is the point: a run that reaches the right answer in eleven steps
    costs eleven times what it should, and the step limit is what stops a loop
    from spending a project's month in an afternoon.
    """
    steps = int(run.get("step") or 0)
    if steps > maximum:
        return Verdict(False, f"took {steps} steps, budget {maximum}")
    return Verdict(True, f"took {steps} of {maximum} steps")


def did_not_loop(run: dict[str, Any], *, limit: int = 2) -> Verdict:
    """The same tool with the same arguments, over and over.

    The signature of a stuck agent: it is not an error, nothing fails, and the
    run may even finish -- having paid for the same answer three times. Repeated
    calls with DIFFERENT arguments are refinement and are left alone.
    """
    seen: dict[tuple[str, str], int] = {}
    for call in invocations(run):
        key = (call.name, json.dumps(call.arguments, sort_keys=True))
        seen[key] = seen.get(key, 0) + 1

    repeated = [(name, count) for (name, _), count in seen.items() if count > limit]
    if repeated:
        name, count = repeated[0]
        return Verdict(False, f"called {name} with identical arguments {count} times")
    return Verdict(True, "no call repeated with identical arguments")


def recovered_from_failure(run: dict[str, Any]) -> Verdict:
    """A failing tool is a fact to reason about, not the end of the run.

    Only meaningful when something DID fail: a run where every tool worked
    passes trivially and says so, rather than claiming a recovery that was never
    tested.
    """
    broken = [call for call in invocations(run) if call.failed or call.refused]
    if not broken:
        return Verdict(True, "nothing failed, so nothing had to be recovered from")

    if run.get("status") != "completed":
        names = ", ".join(sorted({call.name for call in broken}))
        return Verdict(False, f"{names} failed and the run ended {run.get('status')}")

    if not str(run.get("output") or "").strip():
        return Verdict(False, "a tool failed and the run finished with no answer")

    return Verdict(True, f"{len(broken)} call(s) failed and the run still answered")

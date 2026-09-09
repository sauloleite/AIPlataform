"""Records real runs as the trajectory fixtures in evals/trajectories/.

    uv run python tools/scripts/record-trajectories.py

Recorded rather than written by hand: a fixture somebody invented can describe a
run the runtime never produces, and an evaluator built on one measures the
fixture rather than the platform. Re-run this when the transcript shape changes
-- the contract test in apps/agent-runtime is what tells you it has.

It drives the agent loop with the same scripted model the runtime's own tests
use, so it needs no platform, no containers and no model. The ids and timestamps
are overwritten with stable values afterwards: a fixture whose id changes on
every recording produces a diff nobody can read.
"""

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, "apps/agent-runtime/tests")

# After the path insert, deliberately: these modules live in the agent-runtime
# test package, which is not importable until the line above runs.
from agent_fakes import ScriptedModel, a_tool_call
from test_run_agent import Harness, first

from agent_runtime.presentation.http.routes import _run_response
from aia_errors import DomainError, ErrorCode

OUT = pathlib.Path("evals/trajectories")


async def record(
    name: str, model: ScriptedModel, *, tool_failure: DomainError | None = None
) -> dict[str, Any]:
    harness = Harness(model)
    if tool_failure is not None:
        harness.tools.failure = tool_failure
    events = await harness.start()
    run_id = first(events, "run.started").data["run_id"]
    view = await harness.use_case.view(run_id, with_messages=True)
    payload = _run_response(view, with_messages=True)
    # Stable ids: a fixture whose id changes on every recording produces a diff
    # nobody can read and a git history nobody can bisect.
    payload["id"] = f"run-{name}"
    payload["thread_id"] = f"thread-{name}"
    payload["created_at"] = "2026-09-09T12:00:00Z"
    payload["finished_at"] = "2026-09-09T12:00:03Z"
    return payload


async def main() -> None:
    cases = {
        "searches-then-answers": await record(
            "searches-then-answers",
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("knowledge-search", '{"query":"leave policy"}')]),
                    ("You get 30 days of leave.", []),
                ]
            ),
        ),
        "recovers-from-a-failing-tool": await record(
            "recovers-from-a-failing-tool",
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("knowledge-search", '{"query":"leave policy"}')]),
                    ("I could not reach the handbook, but the policy is 30 days.", []),
                ]
            ),
            tool_failure=DomainError(
                "The tool endpoint is down", code=ErrorCode.TOOL_EXECUTION_FAILED, status=502
            ),
        ),
        "asks-for-a-tool-that-does-not-exist": await record(
            "asks-for-a-tool-that-does-not-exist",
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("search-handbook", '{"query":"leave policy"}')]),
                    ("You get 30 days.", []),
                ]
            ),
        ),
        "calls-the-same-tool-over-and-over": await record(
            "calls-the-same-tool-over-and-over",
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("knowledge-search", '{"query":"leave"}', call_id="c1")]),
                    ("", [a_tool_call("knowledge-search", '{"query":"leave"}', call_id="c2")]),
                    ("", [a_tool_call("knowledge-search", '{"query":"leave"}', call_id="c3")]),
                    ("Thirty days.", []),
                ]
            ),
        ),
    }

    for name, payload in cases.items():
        (OUT / f"{name}.json").write_text(json.dumps(payload, indent=2) + "\n")
        calls = [
            c["function"]["name"] for m in payload["messages"] for c in m.get("tool_calls") or []
        ]
        print(f"{name}: status={payload['status']} steps={payload['step']} calls={calls}")


asyncio.run(main())

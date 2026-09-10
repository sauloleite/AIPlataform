"""A run answers the shape its contract declares.

`tools/scripts/check_routes.py` compares methods and paths, and nothing compared
SHAPES — which is how `Message.tool_calls` came to be declared as `ToolCall`
while the transcript stored the provider's wire format. A client generated from
that contract read `tool_name`, `arguments` and `risk_level` as undefined on
every executed tool call, and no test anywhere noticed.

The `contract` marker and `schemathesis` had both been declared for a year and
used by nothing. This validates a real response against the contract's own
schema with no service running, so it gates on every PR rather than only where
containers exist.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml
from agent_fakes import ScriptedModel, a_tool_call
from jsonschema import Draft202012Validator
from test_run_agent import Harness, first

from agent_runtime.presentation.http.routes import _run_response

CONTRACT = Path(__file__).resolve().parents[3] / "contracts/openapi/agent-runtime.v1.yaml"


def schema_for(name: str) -> dict[str, Any]:
    """One component, with the whole document behind it so `$ref` resolves."""
    document = yaml.safe_load(CONTRACT.read_text())
    return {
        "$ref": f"#/components/schemas/{name}",
        "components": document["components"],
    }


def assert_matches(name: str, payload: object) -> None:
    errors = sorted(
        Draft202012Validator(schema_for(name)).iter_errors(payload),
        key=lambda error: list(error.path),
    )
    assert not errors, "\n".join(
        f"{'/'.join(str(part) for part in error.path) or '<root>'}: {error.message}"
        for error in errors
    )


async def a_run_with_a_tool_call() -> dict[str, Any]:
    harness = Harness(
        ScriptedModel(
            turns=[
                (
                    "",
                    [
                        a_tool_call(
                            "merge-request",
                            '{"mr":42}',
                            # One provider requires this echoed back. A test
                            # that never produced one could not prove it is
                            # stripped before a caller sees the transcript.
                            provider_state="opaque-blob-the-provider-wants-back",
                        )
                    ],
                ),
                ("Merged.", []),
            ]
        )
    )
    started = await harness.start()
    run_id = first(started, "run.started").data["run_id"]
    call_id = first(started, "approval.requested").data["tool_call_id"]
    await harness.approve(run_id, call_id)

    view = await harness.use_case.view(run_id, with_messages=True)
    # The route's OWN mapper, not a reimplementation of it: validating a shape
    # this test built would prove only that the test agrees with itself.
    return _run_response(view, with_messages=True)


class TestTheRunDetail:
    async def test_a_transcript_with_a_tool_call_matches_the_contract(self) -> None:
        payload = await a_run_with_a_tool_call()

        # The one that used to fail. `ToolCall` requires `tool_name` and
        # `risk_level`; the transcript has neither, and declaring it that way
        # promised a client fields that were never there.
        for message in payload["messages"]:
            assert_matches("Message", message)

    async def test_a_call_and_its_result_are_linked_by_id(self) -> None:
        payload = await a_run_with_a_tool_call()

        calls = [
            call for message in payload["messages"] for call in message.get("tool_calls") or []
        ]
        results = [m for m in payload["messages"] if m.get("role") == "tool"]

        assert calls, "the transcript recorded no tool call"
        # This link is the whole basis of a trajectory evaluator: without it the
        # order of calls is visible and their outcomes are not.
        assert {call["id"] for call in calls} >= {r["tool_call_id"] for r in results}

    async def test_the_transcript_does_not_leak_the_provider_blob(self) -> None:
        payload = await a_run_with_a_tool_call()

        calls = [
            call for message in payload["messages"] for call in message.get("tool_calls") or []
        ]
        # Opaque, provider-specific and potentially large. A contract that
        # carried it would be promising a shape no provider guarantees.
        assert all("provider_state" not in call for call in calls)


@pytest.mark.parametrize("name", ["Run", "RunDetail", "TranscriptToolCall", "ToolCall"])
def test_every_schema_this_file_leans_on_exists(name: str) -> None:
    # A validator given a `$ref` nothing resolves passes everything, so a typo
    # here would turn the assertions above into decoration.
    assert schema_for(name)["components"]["schemas"].get(name) is not None

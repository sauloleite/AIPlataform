"""Reading an agent definition off the registry, and the checkpoint round trip."""

from __future__ import annotations

import pytest

from agent_runtime.domain.definitions import AgentDefinition
from agent_runtime.domain.entities import Run, RunState, RunStatus, ToolCall
from agent_runtime.infrastructure.mongo import _from_run, _from_state, _to_run, _to_state
from aia_errors import ValidationError


class TestAgentDefinition:
    def test_reads_the_contract_payload(self) -> None:
        definition = AgentDefinition.from_definition(
            {
                "kind": "agent",
                "instructions": "help",
                "model_alias": "chat-fast",
                "tools": [{"asset_id": "t1", "version": None}],
                "knowledge": [{"store_id": "s1"}],
                "temperature": 0.2,
                "max_output_tokens": 900,
            }
        )

        assert definition.tool_asset_ids == ("t1",)
        assert definition.store_ids == ("s1",)
        assert definition.uses_knowledge is True
        assert definition.max_output_tokens == 900

    def test_refuses_a_definition_with_no_instructions(self) -> None:
        # Refused at construction, not at the controller: an agent with nothing
        # to say is not a valid agent in any layer.
        with pytest.raises(ValidationError):
            AgentDefinition.from_definition(
                {"kind": "agent", "instructions": "   ", "model_alias": "chat-fast"}
            )

    def test_refuses_a_definition_with_no_model(self) -> None:
        with pytest.raises(ValidationError):
            AgentDefinition.from_definition(
                {"kind": "agent", "instructions": "help", "model_alias": ""}
            )

    def test_refuses_a_version_that_is_not_an_agent(self) -> None:
        # Publishing a tool under an agent's id would otherwise run something
        # with no instructions and no model.
        with pytest.raises(ValidationError):
            AgentDefinition.from_definition({"kind": "tool", "tool_type": "builtin"})

    def test_skips_a_reference_with_no_id(self) -> None:
        definition = AgentDefinition.from_definition(
            {
                "kind": "agent",
                "instructions": "help",
                "model_alias": "chat-fast",
                "tools": [{"asset_id": "t1"}, {}, "nonsense"],
            }
        )

        assert definition.tool_asset_ids == ("t1",)

    def test_ignores_a_boolean_where_a_number_belongs(self) -> None:
        # `True` is an int in Python; without the guard it would arrive as
        # temperature 1.0 and quietly change how the model answers.
        definition = AgentDefinition.from_definition(
            {
                "kind": "agent",
                "instructions": "help",
                "model_alias": "chat-fast",
                "temperature": True,
                "max_output_tokens": True,
            }
        )

        assert definition.temperature is None
        assert definition.max_output_tokens is None


class TestCheckpointRoundTrip:
    """What resumes a run after a restart. A field lost here is a run that
    resumes as something other than what it was."""

    def test_a_state_survives_the_round_trip(self) -> None:
        state = RunState(
            run_id="run-1",
            project_id="proj-1",
            agent_id="agent-1",
            agent_version=3,
            thread_id="thread-1",
            step=4,
            tool_calls_made=2,
            messages=[{"role": "user", "content": "hi"}],
            definition={"kind": "agent", "instructions": "help", "model_alias": "chat-fast"},
            pending_call=ToolCall(
                id="c1",
                tool_name="merge-request",
                arguments={"mr": 42},
                risk_level="high",
                tool_id="tool-merge",
                requires_approval=True,
            ),
            queued_calls=[ToolCall(id="c2", tool_name="knowledge-search", arguments={})],
        )

        restored = _to_state(_from_state(state))

        assert restored == state

    def test_the_pinned_definition_comes_back(self) -> None:
        # A resume must execute what the run STARTED with: republishing the
        # agent while a human deliberates must not change what then runs.
        state = RunState(
            run_id="run-1",
            project_id="proj-1",
            definition={"kind": "agent", "instructions": "v1", "model_alias": "chat-fast"},
        )

        assert _to_state(_from_state(state)).definition["instructions"] == "v1"

    def test_the_risk_level_of_a_held_call_comes_back(self) -> None:
        # Lost, a high-risk call would resume as low risk and run unapproved.
        state = RunState(
            run_id="run-1",
            project_id="proj-1",
            pending_call=ToolCall(
                id="c1", tool_name="merge-request", arguments={}, risk_level="high"
            ),
        )

        restored = _to_state(_from_state(state))

        assert restored.pending_call is not None
        assert restored.pending_call.risk_level == "high"

    def test_a_run_survives_the_round_trip(self) -> None:
        run = Run(
            id="run-1",
            agent_id="agent-1",
            project_id="proj-1",
            principal_id="user-ana",
            agent_version=3,
            thread_id="thread-1",
            status=RunStatus.WAITING_APPROVAL,
            error_code=None,
            output=None,
        )

        restored = _to_run({"_id": run.id, **_from_run(run)})

        assert restored == run

    def test_a_failed_run_keeps_its_error_code(self) -> None:
        run = Run(id="r", agent_id="a", project_id="p", principal_id="u")
        run.fail("agent_step_limit")

        restored = _to_run({"_id": run.id, **_from_run(run)})

        assert restored.status == RunStatus.FAILED
        assert restored.error_code == "agent_step_limit"
        assert restored.is_terminal is True


def test_the_provider_state_survives_the_checkpoint() -> None:
    """A run held for approval still owes the provider its signature.

    Lost here, the resumed run sends the assistant turn without it and Gemini
    refuses the whole conversation.
    """
    state = RunState(
        run_id="run-1",
        project_id="proj-1",
        pending_call=ToolCall(
            id="c1",
            tool_name="merge-request",
            arguments={},
            risk_level="high",
            provider_state="opaque-signature",
        ),
    )

    restored = _to_state(_from_state(state))

    assert restored.pending_call is not None
    assert restored.pending_call.provider_state == "opaque-signature"

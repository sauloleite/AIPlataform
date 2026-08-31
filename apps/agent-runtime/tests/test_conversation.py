"""The pure mapping between an agent definition and a conversation.

This is where an agent loop goes quietly wrong: a mismatched id detaches a
result from the call that produced it, and the model answers confidently about
the wrong thing.
"""

from __future__ import annotations

import pytest
from agent_fakes import AGENT_DEFINITION, MERGE, SEARCH

from agent_runtime.domain.conversation import (
    allowed_tools,
    assistant_message,
    bind_all,
    bind_store,
    declarations_for,
    opening_messages,
    parse_arguments,
    resolve_calls,
)
from agent_runtime.domain.definitions import AgentDefinition
from agent_runtime.domain.entities import ToolCall

DEFINITION = AgentDefinition.from_definition(AGENT_DEFINITION)


class TestDeclarations:
    def test_uses_the_slug_and_not_the_display_name(self) -> None:
        # `name` is a human label and may hold spaces; it would not survive a
        # provider round trip as a function name.
        declared = declarations_for([SEARCH])

        assert declared[0]["function"]["name"] == "knowledge-search"

    def test_gives_a_tool_with_no_schema_an_empty_object(self) -> None:
        # A missing `parameters` is rejected by some providers outright, and
        # read as "any argument at all" by the rest.
        declared = declarations_for([MERGE])

        assert declared[0]["function"]["parameters"] == {"type": "object", "properties": {}}

    def test_leaves_out_a_description_the_tool_never_had(self) -> None:
        assert "description" not in declarations_for([MERGE])[0]["function"]


class TestAllowedTools:
    def test_intersects_the_definition_with_what_the_project_allows(self) -> None:
        assert allowed_tools(DEFINITION, [SEARCH, MERGE]) == [SEARCH, MERGE]

    def test_a_withdrawn_tool_is_not_offered(self) -> None:
        assert allowed_tools(DEFINITION, [SEARCH]) == [SEARCH]

    def test_a_tool_the_agent_never_asked_for_is_not_offered_either(self) -> None:
        # The intersection, never the union: the project allowing something is
        # not the agent being designed to use it.
        stray = type(SEARCH)(tool_id="tool-other", slug="other", name="Other")

        assert allowed_tools(DEFINITION, [SEARCH, stray]) == [SEARCH]

    def test_an_agent_with_no_tools_gets_none(self) -> None:
        bare = AgentDefinition(instructions="hi", model_alias="chat-fast")

        assert allowed_tools(bare, [SEARCH, MERGE]) == []


class TestResolveCalls:
    def test_maps_a_name_onto_the_registry_asset_behind_it(self) -> None:
        [call] = resolve_calls(
            [{"id": "c1", "function": {"name": "knowledge-search", "arguments": '{"q":"x"}'}}],
            [SEARCH],
        )

        assert call.tool_id == "tool-search"
        assert call.arguments == {"q": "x"}
        assert call.risk_level == "low"

    def test_carries_the_risk_and_the_approval_requirement_across(self) -> None:
        [call] = resolve_calls(
            [{"id": "c1", "function": {"name": "merge-request", "arguments": "{}"}}], [MERGE]
        )

        assert call.risk_level == "high"
        assert call.requires_approval is True

    def test_an_invented_name_resolves_to_nothing_rather_than_raising(self) -> None:
        # The model made it up. Telling it so is the useful answer; an
        # exception would hide a fixable mistake behind a 500.
        [call] = resolve_calls(
            [{"id": "c1", "function": {"name": "rm_rf", "arguments": "{}"}}], [SEARCH]
        )

        assert call.tool_id is None
        assert call.is_resolvable is False
        # And it must not inherit a risk level it was never assigned.
        assert call.requires_approval is False

    def test_gives_an_unnamed_call_a_stable_id(self) -> None:
        calls = resolve_calls(
            [
                {"function": {"name": "knowledge-search", "arguments": "{}"}},
                {"function": {"name": "knowledge-search", "arguments": "{}"}},
            ],
            [SEARCH],
        )

        assert [call.id for call in calls] == ["call_0", "call_1"]

    def test_reads_the_flat_shape_some_providers_use(self) -> None:
        [call] = resolve_calls(
            [{"id": "c1", "name": "knowledge-search", "arguments": {"q": "x"}}], [SEARCH]
        )

        assert call.tool_id == "tool-search"
        assert call.arguments == {"q": "x"}


class TestParseArguments:
    @pytest.mark.parametrize(
        "raw",
        ["", "   ", "not json", "[1,2]", '"a string"', "null"],
        ids=["empty", "blank", "garbage", "array", "string", "null"],
    )
    def test_anything_that_is_not_an_object_becomes_an_empty_one(self, raw: str) -> None:
        # The model wrote this string; malformed JSON is its mistake, not a
        # reason for the run to end in a stack trace.
        assert parse_arguments(raw) == {}

    def test_an_object_that_already_arrived_parsed_is_kept(self) -> None:
        assert parse_arguments({"q": "x"}) == {"q": "x"}

    def test_none_is_an_empty_object(self) -> None:
        assert parse_arguments(None) == {}


class TestAssistantMessage:
    def test_echoes_the_call_id_the_provider_will_match_on(self) -> None:
        call = ToolCall(id="c1", tool_name="knowledge-search", arguments={"q": "x"})

        message = assistant_message("", [call])

        assert message["tool_calls"][0]["id"] == "c1"
        assert message["tool_calls"][0]["function"]["arguments"] == '{"q": "x"}'

    def test_keeps_content_present_even_when_empty(self) -> None:
        # Some providers reject an assistant turn with no content field at all.
        message = assistant_message("", [ToolCall(id="c1", tool_name="x", arguments={})])

        assert "content" in message

    def test_omits_the_key_entirely_when_no_tool_was_called(self) -> None:
        assert "tool_calls" not in assistant_message("Just an answer.", [])


def test_opening_messages_put_the_instructions_first() -> None:
    messages = opening_messages(DEFINITION, "how much leave?")

    assert messages[0] == {"role": "system", "content": "You help with the handbook."}
    assert messages[1] == {"role": "user", "content": "how much leave?"}


class TestBindStore:
    """Which vector store a `file_search` call actually searches.

    The agent's attachment decides, never the model. Inside one project the
    tenant filter would not catch a borrowed store id, because the tenant is
    the same -- the attachment is the only boundary there is.
    """

    def test_supplies_the_attached_store_when_the_model_named_none(self) -> None:
        call = ToolCall(id="c1", tool_name="knowledge-search", arguments={"query": "leave"})

        bound = bind_store(call, SEARCH, DEFINITION)

        assert bound.arguments == {"query": "leave", "store_id": "store-1"}
        assert bound.blocked_reason is None

    def test_keeps_a_store_the_agent_really_is_attached_to(self) -> None:
        two = AgentDefinition(
            instructions="help", model_alias="chat-fast", store_ids=("store-1", "store-2")
        )
        call = ToolCall(
            id="c1", tool_name="knowledge-search", arguments={"query": "x", "store_id": "store-2"}
        )

        assert bind_store(call, SEARCH, two).arguments["store_id"] == "store-2"

    def test_blocks_a_store_the_agent_was_never_attached_to(self) -> None:
        call = ToolCall(
            id="c1",
            tool_name="knowledge-search",
            arguments={"query": "x", "store_id": "someone-elses-store"},
        )

        bound = bind_store(call, SEARCH, DEFINITION)

        assert bound.is_blocked
        assert "not attached" in (bound.blocked_reason or "")
        # And it does not quietly fall back to a store that IS attached: that
        # would answer a question about the wrong documents.
        assert bound.arguments["store_id"] == "someone-elses-store"

    def test_blocks_when_the_agent_has_no_store_at_all(self) -> None:
        bare = AgentDefinition(instructions="help", model_alias="chat-fast")
        call = ToolCall(id="c1", tool_name="knowledge-search", arguments={"query": "x"})

        bound = bind_store(call, SEARCH, bare)

        assert bound.is_blocked
        assert "no vector store" in (bound.blocked_reason or "")

    def test_leaves_a_tool_that_is_not_file_search_alone(self) -> None:
        call = ToolCall(id="c1", tool_name="merge-request", arguments={"mr": 42})

        assert bind_store(call, MERGE, DEFINITION) == call

    def test_binds_a_whole_batch_and_ignores_a_name_nothing_answers_to(self) -> None:
        calls = [
            ToolCall(id="c1", tool_name="knowledge-search", arguments={"query": "x"}),
            ToolCall(id="c2", tool_name="invented", arguments={}),
        ]

        bound = bind_all(calls, [SEARCH, MERGE], DEFINITION)

        assert bound[0].arguments["store_id"] == "store-1"
        assert bound[1] == calls[1]


class TestFileSearchDeclaration:
    def test_hides_the_store_argument_when_there_is_only_one(self) -> None:
        [declared] = declarations_for([SEARCH], DEFINITION)

        # Asking the model to repeat an id it was told is a way to get it wrong.
        assert "store_id" not in declared["function"]["parameters"]["properties"]
        assert declared["function"]["parameters"]["required"] == ["query"]

    def test_offers_the_attached_stores_as_an_enum_when_there_are_several(self) -> None:
        two = AgentDefinition(
            instructions="help", model_alias="chat-fast", store_ids=("store-1", "store-2")
        )

        [declared] = declarations_for([SEARCH], two)
        store = declared["function"]["parameters"]["properties"]["store_id"]

        # An enum, not an open string: the model cannot name what is not there.
        assert store["enum"] == ["store-1", "store-2"]

    def test_a_plain_tool_keeps_its_own_schema(self) -> None:
        [declared] = declarations_for([MERGE], DEFINITION)

        assert declared["function"]["parameters"] == {"type": "object", "properties": {}}


class TestProviderState:
    """Opaque state the provider demands back on the next turn.

    Gemini returns a `thoughtSignature` beside every function call and answers
    400 without it. Dropping the assistant turn instead answers 200 and the
    model ignores the tool result — which is the failure nobody would notice.
    """

    def test_reads_it_off_the_call_the_router_reported(self) -> None:
        [call] = resolve_calls(
            [
                {
                    "id": "c1",
                    "function": {"name": "knowledge-search", "arguments": "{}"},
                    "provider_state": "opaque-signature",
                }
            ],
            [SEARCH],
        )

        assert call.provider_state == "opaque-signature"

    def test_echoes_it_back_unchanged(self) -> None:
        call = ToolCall(
            id="c1",
            tool_name="knowledge-search",
            arguments={},
            provider_state="opaque-signature",
        )

        message = assistant_message("", [call])

        assert message["tool_calls"][0]["provider_state"] == "opaque-signature"

    def test_leaves_the_field_out_for_a_provider_that_needs_none(self) -> None:
        # OpenAI and Anthropic reject an unknown field in a tool call.
        call = ToolCall(id="c1", tool_name="knowledge-search", arguments={})

        assert "provider_state" not in assistant_message("", [call])["tool_calls"][0]

    def test_an_empty_signature_is_the_same_as_none(self) -> None:
        # Echoing an empty string back is not echoing the signature back.
        [call] = resolve_calls(
            [{"id": "c1", "function": {"name": "knowledge-search"}, "provider_state": ""}],
            [SEARCH],
        )

        assert call.provider_state is None

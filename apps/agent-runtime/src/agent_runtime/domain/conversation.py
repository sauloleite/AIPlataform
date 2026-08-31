"""Turning an agent definition into a conversation, and back.

Pure: no clock, no I/O, no provider. Everything here is the fiddly part of an
agent loop — the part where a wrong `id` silently detaches a result from its
call and the model answers about the wrong thing.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from agent_runtime.domain.definitions import (
    STORE_ARGUMENT,
    AgentDefinition,
    AvailableTool,
)
from agent_runtime.domain.entities import ToolCall


def system_message(definition: AgentDefinition) -> dict[str, Any]:
    return {"role": "system", "content": definition.instructions}


def opening_messages(definition: AgentDefinition, user_input: str) -> list[dict[str, Any]]:
    return [system_message(definition), {"role": "user", "content": user_input}]


def declarations_for(
    tools: list[AvailableTool], definition: AgentDefinition | None = None
) -> list[dict[str, Any]]:
    """What the model is told it may call, in the router's contract shape."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.slug,
                **({"description": tool.description} if tool.description else {}),
                "parameters": _schema_for(tool, definition),
            },
        }
        for tool in tools
    ]


def _schema_for(tool: AvailableTool, definition: AgentDefinition | None) -> dict[str, Any]:
    """`file_search` gets a schema the agent's attachment defines.

    The stores are listed as an enum rather than left open, so the model cannot
    name one this agent was never attached to. `store_id` stays optional: with a
    single store there is nothing to choose, and asking the model to repeat an
    id it was told is a way to get it wrong.
    """
    if tool.is_file_search:
        stores = list(definition.store_ids) if definition is not None else []
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look up."},
                **({STORE_ARGUMENT: {"type": "string", "enum": stores}} if len(stores) > 1 else {}),
            },
            "required": ["query"],
        }

    return tool.parameters or {"type": "object", "properties": {}}


def bind_store(call: ToolCall, tool: AvailableTool, definition: AgentDefinition) -> ToolCall:
    """Decides which vector store a `file_search` call searches.

    The AGENT's attachment decides, never the model. Left to the model, a
    hallucinated or borrowed store id would send the question at a store nobody
    granted this agent -- and inside one project the tenant filter would not
    catch it, because the tenant is the same.

    A call that cannot be bound comes back blocked rather than raising: the
    model asked for something it may not have, and the useful answer is to tell
    it so on the next turn, not to end the run.
    """
    if not tool.is_file_search:
        return call

    named = str(call.arguments.get(STORE_ARGUMENT) or "")
    stores = definition.store_ids

    if not stores:
        return replace(call, blocked_reason="This agent has no vector store attached.")
    if named and named not in stores:
        return replace(call, blocked_reason=f"The store {named!r} is not attached to this agent.")

    chosen = named or stores[0]
    return replace(call, arguments={**call.arguments, STORE_ARGUMENT: chosen})


def bind_all(
    calls: list[ToolCall], tools: list[AvailableTool], definition: AgentDefinition
) -> list[ToolCall]:
    """Binds every call before any of them runs, so a held one resumes bound."""
    by_slug = {tool.slug: tool for tool in tools}
    return [
        bind_store(call, by_slug[call.tool_name], definition) if call.tool_name in by_slug else call
        for call in calls
    ]


def allowed_tools(
    definition: AgentDefinition, effective: list[AvailableTool]
) -> list[AvailableTool]:
    """The agent's tools intersected with what the project actually allows.

    The intersection, never the union: a definition naming a tool the project
    withdrew must not resurrect it, and the gateway would refuse the call
    anyway — telling the model about it only buys a wasted turn.
    """
    wanted = set(definition.tool_asset_ids)
    return [tool for tool in effective if tool.tool_id in wanted]


def assistant_message(content: str, calls: list[ToolCall]) -> dict[str, Any]:
    """The assistant turn, echoed back verbatim on the next call.

    Providers match a result to its call by this id, so it has to survive the
    round trip unchanged. `content` stays present even when empty: some
    providers reject an assistant turn with no content field at all.
    """
    return {
        "role": "assistant",
        "content": content,
        **(
            {
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.tool_name,
                            "arguments": json.dumps(call.arguments, ensure_ascii=False),
                        },
                        # Carried, never read. Without it Gemini refuses the
                        # next turn, and omitting the whole assistant turn
                        # instead makes the model ignore the tool result while
                        # still answering 200.
                        **(
                            {"provider_state": call.provider_state}
                            if call.provider_state is not None
                            else {}
                        ),
                    }
                    for call in calls
                ]
            }
            if calls
            else {}
        ),
    }


def resolve_calls(raw_calls: list[dict[str, Any]], tools: list[AvailableTool]) -> list[ToolCall]:
    """Maps what the model asked for onto tools the caller may actually run.

    A name nothing answers to yields a call with `tool_id=None` rather than an
    exception: the model made it up, and the honest response is to tell it so on
    the next turn, not to end the run.
    """
    by_slug = {tool.slug: tool for tool in tools}

    return [
        _one_call(raw, by_slug.get(_name_of(raw)), index) for index, raw in enumerate(raw_calls)
    ]


def _one_call(raw: dict[str, Any], tool: AvailableTool | None, index: int) -> ToolCall:
    name = _name_of(raw)
    state = raw.get("provider_state")
    return ToolCall(
        id=str(raw.get("id") or f"call_{index}"),
        tool_name=name,
        arguments=parse_arguments(_arguments_of(raw)),
        risk_level=tool.risk_level if tool is not None else "low",
        tool_id=tool.tool_id if tool is not None else None,
        requires_approval=tool.requires_approval if tool is not None else False,
        provider_state=str(state) if isinstance(state, str) and state else None,
    )


def parse_arguments(raw: Any) -> dict[str, Any]:
    """The model wrote this string. Malformed JSON is its mistake, not a crash."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or raw.strip() == "":
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _name_of(raw: dict[str, Any]) -> str:
    function = raw.get("function")
    if isinstance(function, dict):
        return str(function.get("name") or "")
    return str(raw.get("name") or "")


def _arguments_of(raw: dict[str, Any]) -> Any:
    function = raw.get("function")
    if isinstance(function, dict):
        return function.get("arguments")
    return raw.get("arguments")

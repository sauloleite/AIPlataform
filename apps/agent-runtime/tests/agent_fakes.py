"""Fakes that honour the contract for real.

They verify BEHAVIOUR — did the tool run? was the caller's token the one that
travelled? — rather than a call sequence. A test bound to mocks breaks on every
refactoring without pointing at a defect.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from agent_runtime.domain.definitions import AgentDefinition, AvailableTool, ResolvedAgent
from agent_runtime.domain.entities import ToolCall
from aia_errors import DomainError, ErrorCode

AGENT_DEFINITION: dict[str, Any] = {
    "kind": "agent",
    "instructions": "You help with the handbook.",
    "model_alias": "chat-fast",
    "tools": [{"asset_id": "tool-search"}, {"asset_id": "tool-merge"}],
    "knowledge": [{"store_id": "store-1"}],
}

SEARCH = AvailableTool(
    tool_id="tool-search",
    slug="knowledge-search",
    name="Knowledge search",
    description="Retrieval from a vector store",
    risk_level="low",
    builtin_id="file_search",
    parameters={"type": "object", "properties": {"query": {"type": "string"}}},
)

MERGE = AvailableTool(
    tool_id="tool-merge",
    slug="merge-request",
    name="Merge request",
    risk_level="high",
    requires_approval=True,
)


@dataclass(slots=True)
class FakeAgentSource:
    version: int = 3
    raw: dict[str, Any] = field(default_factory=lambda: dict(AGENT_DEFINITION))
    tokens_seen: list[str] = field(default_factory=list)
    failure: Exception | None = None

    async def resolve(self, *, agent_id: str, project_id: str, access_token: str) -> ResolvedAgent:
        _ = project_id
        self.tokens_seen.append(access_token)
        if self.failure is not None:
            raise self.failure
        return ResolvedAgent(
            agent_id=agent_id,
            version=self.version,
            definition=AgentDefinition.from_definition(self.raw),
            raw=self.raw,
        )


@dataclass(slots=True)
class FakeToolCatalog:
    tools: list[AvailableTool] = field(default_factory=lambda: [SEARCH, MERGE])
    tokens_seen: list[str] = field(default_factory=list)

    async def effective(self, *, project_id: str, access_token: str) -> list[AvailableTool]:
        _ = project_id
        self.tokens_seen.append(access_token)
        return list(self.tools)


@dataclass(slots=True)
class FakeToolGateway:
    invocations: list[tuple[ToolCall, str, str]] = field(default_factory=list)
    approvals_carried: list[bool] = field(default_factory=list)
    result: Any = "30 days of leave"
    failure: DomainError | None = None

    async def invoke(
        self,
        *,
        call: ToolCall,
        principal_id: str,
        project_id: str,
        access_token: str,
        human_approved: bool = False,
    ) -> dict[str, Any]:
        self.invocations.append((call, principal_id, access_token))
        self.approvals_carried.append(human_approved)
        _ = project_id
        if self.failure is not None:
            raise self.failure
        return {"status": "ok", "result": self.result, "duration_ms": 12}

    def fail_with(self, code: str, message: str, status: int = 403) -> None:
        self.failure = DomainError(message, code=code, status=status)


@dataclass(slots=True)
class ScriptedModel:
    """Replays a scripted list of turns.

    Each turn is `(text, tool_calls)`. The scripted answer is what makes an
    agent loop testable at all: a real model would decide differently every run.
    """

    turns: list[tuple[str, list[dict[str, Any]]]] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    failure: Exception | None = None

    def stream(
        self,
        *,
        alias: str,
        messages: list[dict[str, Any]],
        project_id: str,
        access_token: str,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        self.calls.append(
            {
                "alias": alias,
                "messages": [dict(message) for message in messages],
                "project_id": project_id,
                "access_token": access_token,
                "tools": tools,
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
            }
        )
        index = len(self.calls) - 1
        return self._replay(index)

    async def _replay(self, index: int) -> AsyncIterator[dict[str, Any]]:
        if self.failure is not None:
            raise self.failure

        text, tool_calls = (
            self.turns[index] if index < len(self.turns) else ("I have nothing else.", [])
        )
        # Split into two deltas so a test can tell streaming from buffering.
        if text:
            middle = max(1, len(text) // 2)
            yield {"kind": "delta", "content": text[:middle]}
            yield {"kind": "delta", "content": text[middle:]}
        yield {
            "kind": "finished",
            "content": text,
            "tool_calls": tool_calls,
            "finish_reason": "tool_calls" if tool_calls else "stop",
        }


def a_tool_call(
    name: str,
    arguments: str = '{"query":"leave"}',
    call_id: str = "call_1",
    provider_state: str | None = None,
) -> dict[str, Any]:
    """What a provider sends when the model asks for a tool.

    `provider_state` is the opaque blob one provider requires echoed back on the
    next turn. It defaults to absent because most providers send none, and is
    settable because a test that never produces one cannot prove it is stripped
    before a caller sees the transcript.
    """
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": arguments},
        **({"provider_state": provider_state} if provider_state is not None else {}),
    }


UNAVAILABLE = DomainError(
    "The tool endpoint is down", code=ErrorCode.TOOL_EXECUTION_FAILED, status=502
)

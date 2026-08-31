"""Ports as Protocols.

Adapters do not inherit: they merely satisfy the signature, and mypy checks it
(reference doc 03 §3.3).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol

from agent_runtime.domain.definitions import AvailableTool, ResolvedAgent
from agent_runtime.domain.entities import Run, RunState, ToolCall


class RunRepository(Protocol):
    async def find(self, run_id: str) -> Run | None: ...
    async def save(self, run: Run) -> None: ...


class Checkpointer(Protocol):
    """Persists the state so a run survives a restart."""

    async def save(self, state: RunState) -> None: ...
    async def load(self, run_id: str) -> RunState | None: ...


class AgentSource(Protocol):
    """Resolves the PUBLISHED definition a run executes.

    Read as the caller, never with a service credential: a service principal is
    a member of no project, so the registry would refuse it (ADR-017).
    """

    async def resolve(
        self, *, agent_id: str, project_id: str, access_token: str
    ) -> ResolvedAgent: ...


class ToolCatalog(Protocol):
    """What aia-mcp-gateway says this caller may actually run."""

    async def effective(self, *, project_id: str, access_token: str) -> list[AvailableTool]: ...


class ToolGateway(Protocol):
    """Invokes tools behind aia-mcp-gateway, with the user identity.

    `human_approved` says a person saw these exact arguments and said yes. The
    gateway holds high-risk calls too, and without this the two controls
    deadlock: the runtime asks a person, and the gateway then asks a person
    nobody is there to be.
    """

    async def invoke(
        self,
        *,
        call: ToolCall,
        principal_id: str,
        project_id: str,
        access_token: str,
        human_approved: bool = False,
    ) -> dict[str, Any]: ...


class ModelClient(Protocol):
    """Inference-router client. An agent never talks to a provider directly.

    There is one method, not a streaming one beside a blocking one: the loop
    always streams, and the blocking endpoint drains it. Two paths through a
    model call is two places for the tool handling to be subtly different.

    It yields dicts of two shapes, and nothing else:
      `{"kind": "delta", "content": str}` while the answer is arriving, and
      `{"kind": "finished", "content": str, "tool_calls": [...], "aia": {...}}`
    once. `tool_calls` carries the OpenAI wire shape the router publishes.
    """

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
    ) -> AsyncIterator[dict[str, Any]]: ...

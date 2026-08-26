"""Ports as Protocols.

Adapters do not inherit: they merely satisfy the signature, and mypy checks it
(reference doc 03 §3.3).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol

from agent_runtime.domain.entities import Run, RunState, ToolCall


class RunRepository(Protocol):
    async def find(self, run_id: str) -> Run | None: ...
    async def save(self, run: Run) -> None: ...


class Checkpointer(Protocol):
    """Persists the state so a run survives a restart."""

    async def save(self, state: RunState) -> None: ...
    async def load(self, run_id: str) -> RunState | None: ...


class ToolGateway(Protocol):
    """Invokes tools behind aia-mcp-gateway, with the user identity."""

    async def invoke(
        self, *, call: ToolCall, principal_id: str, project_id: str
    ) -> dict[str, Any]: ...


class ModelClient(Protocol):
    """Inference-router client. An agent never talks to a provider directly."""

    async def chat(
        self, *, alias: str, messages: list[dict[str, Any]], project_id: str
    ) -> dict[str, Any]: ...

    def stream(
        self, *, alias: str, messages: list[dict[str, Any]], project_id: str
    ) -> AsyncIterator[str]: ...

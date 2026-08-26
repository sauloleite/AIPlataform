"""Ports como Protocol.

Adapters nao herdam: so cumprem a assinatura, e o mypy verifica (doc 03, 3.3).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol

from agent_runtime.domain.entities import Run, RunState, ToolCall


class RunRepository(Protocol):
    async def find(self, run_id: str) -> Run | None: ...
    async def save(self, run: Run) -> None: ...


class Checkpointer(Protocol):
    """Persiste o estado para que a execucao sobreviva a um restart."""

    async def save(self, state: RunState) -> None: ...
    async def load(self, run_id: str) -> RunState | None: ...


class ToolGateway(Protocol):
    """Invoca tools atras do aia-mcp-gateway, com a identidade do usuario."""

    async def invoke(
        self, *, call: ToolCall, principal_id: str, project_id: str
    ) -> dict[str, Any]: ...


class ModelClient(Protocol):
    """Cliente do inference-router. O agente nunca fala com provedor direto."""

    async def chat(
        self, *, alias: str, messages: list[dict[str, Any]], project_id: str
    ) -> dict[str, Any]: ...

    def stream(
        self, *, alias: str, messages: list[dict[str, Any]], project_id: str
    ) -> AsyncIterator[str]: ...

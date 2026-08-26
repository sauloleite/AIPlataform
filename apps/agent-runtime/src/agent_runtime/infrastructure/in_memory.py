"""Adapters em memoria.

Sao o que faz o servico subir e responder na Fase 0. MongoDB para checkpoints e
o cliente MCP entram na Fase 3; os ports ja isolam essa troca.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent_runtime.domain.entities import Run, RunState, ToolCall


@dataclass(slots=True)
class InMemoryRunRepository:
    _runs: dict[str, Run] = field(default_factory=dict)

    async def find(self, run_id: str) -> Run | None:
        return self._runs.get(run_id)

    async def save(self, run: Run) -> None:
        self._runs[run.id] = run


@dataclass(slots=True)
class InMemoryCheckpointer:
    _states: dict[str, RunState] = field(default_factory=dict)

    async def save(self, state: RunState) -> None:
        self._states[state.run_id] = state

    async def load(self, run_id: str) -> RunState | None:
        return self._states.get(run_id)


@dataclass(slots=True)
class RecordingToolGateway:
    """Gateway de tools que so registra. Substituido pelo MCP na Fase 3."""

    invocations: list[tuple[ToolCall, str, str]] = field(default_factory=list)

    async def invoke(self, *, call: ToolCall, principal_id: str, project_id: str) -> dict[str, Any]:
        self.invocations.append((call, principal_id, project_id))
        return {"tool_id": call.tool_id, "status": "nao_implementado", "arguments": call.arguments}

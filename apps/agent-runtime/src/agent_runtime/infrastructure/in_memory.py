"""In-memory adapters.

They are what makes the service start and answer in phase 0. MongoDB for
checkpoints and the MCP client arrive in phase 3; the ports already isolate that
swap.
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
    """A tool gateway that only records. Replaced by MCP in phase 3."""

    invocations: list[tuple[ToolCall, str, str]] = field(default_factory=list)

    async def invoke(self, *, call: ToolCall, principal_id: str, project_id: str) -> dict[str, Any]:
        self.invocations.append((call, principal_id, project_id))
        return {
            "tool_id": call.tool_id,
            "status": "not_implemented",
            "arguments": call.arguments,
        }

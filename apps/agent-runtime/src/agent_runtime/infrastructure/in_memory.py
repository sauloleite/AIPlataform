"""In-memory adapters.

They keep the service startable with no database, and they are what the unit
tests run against. The ports isolate the swap: nothing above this file knows
whether a run lives in a dict or in Mongo.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from agent_runtime.domain.entities import Run, RunState


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

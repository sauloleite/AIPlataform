"""Commands and results. No HTTP detail."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class StartRunCommand:
    agent_id: str
    project_id: str
    principal_id: str
    input: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ApproveToolCallCommand:
    run_id: str
    tool_call_id: str
    principal_id: str
    principal_roles: frozenset[str]


@dataclass(frozen=True, slots=True)
class RunView:
    id: str
    agent_id: str
    project_id: str
    status: str
    step: int

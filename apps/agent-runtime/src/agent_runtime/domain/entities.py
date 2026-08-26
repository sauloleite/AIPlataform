"""Entidades do runtime. Dataclasses puras, sem framework."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class RunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    tool_id: str
    arguments: dict[str, Any]
    risk_level: str = "low"


@dataclass(slots=True)
class RunState:
    """Estado de uma execucao, pronto para ser persistido como checkpoint.

    Existe separado do `Run` porque e ele que o checkpointer serializa: a
    execucao duravel da Fase 3 precisa retomar exatamente daqui.
    """

    run_id: str
    project_id: str
    step: int = 0
    messages: list[dict[str, Any]] = field(default_factory=list)
    pending_call: ToolCall | None = None

    def is_waiting_approval(self, tool_call_id: str) -> bool:
        return self.pending_call is not None and self.pending_call.id == tool_call_id


@dataclass(slots=True)
class Run:
    id: str
    agent_id: str
    project_id: str
    principal_id: str
    status: RunStatus = RunStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    error_code: str | None = None

    def start(self) -> None:
        self.status = RunStatus.RUNNING

    def request_approval(self) -> None:
        self.status = RunStatus.WAITING_APPROVAL

    def complete(self, at: datetime | None = None) -> None:
        self.status = RunStatus.COMPLETED
        self.finished_at = at or datetime.now(UTC)

    def fail(self, error_code: str, at: datetime | None = None) -> None:
        self.status = RunStatus.FAILED
        self.error_code = error_code
        self.finished_at = at or datetime.now(UTC)

    @property
    def is_terminal(self) -> bool:
        return self.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}

"""Runtime entities. Plain dataclasses, no framework."""

from __future__ import annotations

import json
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
    """One call the model asked for.

    `tool_name` is what the model said; `tool_id` is the registry asset it
    resolves to, and is None when the model invented a name nothing answers to.
    Keeping both means a hallucinated call can be reported back to the model as
    a result rather than crashing the run.
    """

    id: str
    tool_name: str
    arguments: dict[str, Any]
    risk_level: str = "low"
    tool_id: str | None = None
    requires_approval: bool = False
    #: Why this call will not run, decided before it was ever sent. It travels
    #: with the call through the checkpoint so a resumed run refuses it for the
    #: same reason it was refused the first time.
    blocked_reason: str | None = None
    #: Opaque provider state that has to go back UNCHANGED on the next turn.
    #: Gemini answers 400 without its `thoughtSignature`, so this survives the
    #: checkpoint too -- a run resumed after an approval still owes it.
    provider_state: str | None = None

    @property
    def is_resolvable(self) -> bool:
        return self.tool_id is not None

    @property
    def is_blocked(self) -> bool:
        return self.blocked_reason is not None


@dataclass(slots=True)
class RunState:
    """The state of a run, ready to be persisted as a checkpoint.

    It is separate from `Run` because this is what the checkpointer serialises:
    a run has to resume from exactly here after a restart.
    """

    run_id: str
    project_id: str
    agent_id: str = ""
    agent_version: int = 0
    thread_id: str = ""
    step: int = 0
    tool_calls_made: int = 0
    messages: list[dict[str, Any]] = field(default_factory=list)
    #: The registry definition this run is pinned to, kept here so a resume
    #: after an approval executes what the run STARTED with -- republishing the
    #: agent while a human deliberates must not change what then runs.
    definition: dict[str, Any] = field(default_factory=dict)
    pending_call: ToolCall | None = None
    #: The rest of a batch the model asked for in one turn. Without this a call
    #: held for approval would swallow the calls that came after it, and the
    #: model would answer from half the results it asked for.
    queued_calls: list[ToolCall] = field(default_factory=list)

    def is_waiting_approval(self, tool_call_id: str) -> bool:
        return self.pending_call is not None and self.pending_call.id == tool_call_id

    def hold_for_approval(self, call: ToolCall, rest: list[ToolCall]) -> None:
        self.pending_call = call
        self.queued_calls = list(rest)

    def take_queued(self) -> list[ToolCall]:
        queued, self.queued_calls = self.queued_calls, []
        return queued

    def record_tool_result(self, call: ToolCall, result: Any) -> None:
        """Appends the result and clears the hold, in that order.

        A result the model can read has to be text: providers reject a tool
        message whose content is an object, and the model reads it as text
        either way.
        """
        self.messages.append(
            {
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.tool_name,
                "content": as_text(result),
            }
        )
        self.pending_call = None
        self.tool_calls_made += 1
        self.step += 1

    @property
    def last_assistant_text(self) -> str:
        for message in reversed(self.messages):
            if message.get("role") == "assistant":
                content = message.get("content")
                return content if isinstance(content, str) else ""
        return ""


@dataclass(slots=True)
class Run:
    id: str
    agent_id: str
    project_id: str
    principal_id: str
    agent_version: int = 0
    thread_id: str = ""
    status: RunStatus = RunStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    error_code: str | None = None
    output: str | None = None

    def start(self) -> None:
        self.status = RunStatus.RUNNING

    def request_approval(self) -> None:
        self.status = RunStatus.WAITING_APPROVAL

    def resume(self) -> None:
        self.status = RunStatus.RUNNING

    def complete(self, output: str = "", at: datetime | None = None) -> None:
        self.status = RunStatus.COMPLETED
        self.output = output
        self.finished_at = at or datetime.now(UTC)

    def fail(self, error_code: str, at: datetime | None = None) -> None:
        self.status = RunStatus.FAILED
        self.error_code = error_code
        self.finished_at = at or datetime.now(UTC)

    @property
    def is_terminal(self) -> bool:
        return self.status in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}

    @property
    def is_resumable(self) -> bool:
        return self.status == RunStatus.WAITING_APPROVAL


def as_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(result)

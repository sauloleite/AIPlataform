"""Commands, events and results. No HTTP detail."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from agent_runtime.domain.entities import Run, RunState, ToolCall


@dataclass(frozen=True, slots=True)
class Caller:
    """Who the run acts as, all the way down.

    The token travels with every outbound call: the registry, the gateway and
    the router each authorise the PERSON, not this service (ADR-017). A service
    credential would be a member of no project and would sail past a check the
    user would have failed.
    """

    principal_id: str
    project_id: str
    access_token: str
    roles: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class StartRunCommand:
    agent_id: str
    caller: Caller
    input: str
    thread_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ApproveToolCallCommand:
    run_id: str
    tool_call_id: str
    caller: Caller
    approved: bool = True
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class RunView:
    id: str
    agent_id: str
    agent_version: int
    thread_id: str
    project_id: str
    principal_id: str
    status: str
    step: int
    output: str | None = None
    pending_call: ToolCall | None = None
    error_code: str | None = None
    created_at: str = ""
    finished_at: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)


def view_of(run: Run, state: RunState, *, with_messages: bool = False) -> RunView:
    return RunView(
        id=run.id,
        agent_id=run.agent_id,
        agent_version=run.agent_version,
        thread_id=run.thread_id,
        project_id=run.project_id,
        principal_id=run.principal_id,
        status=run.status.value,
        step=state.step,
        output=run.output,
        pending_call=state.pending_call,
        error_code=run.error_code,
        created_at=run.created_at.isoformat().replace("+00:00", "Z"),
        finished_at=(
            run.finished_at.isoformat().replace("+00:00", "Z")
            if run.finished_at is not None
            else None
        ),
        messages=[_public(message) for message in state.messages] if with_messages else [],
    )


#: What the SSE endpoint emits. A union rather than a bag of optional fields, so
#: a consumer that forgets a case fails a type check instead of at runtime.
RunEventKind = Literal[
    "run.started",
    "message.delta",
    "tool.call",
    "tool.result",
    "approval.requested",
    "run.finished",
    "error",
]


@dataclass(frozen=True, slots=True)
class RunEvent:
    kind: RunEventKind
    data: dict[str, Any]


def _public(message: dict[str, Any]) -> dict[str, Any]:
    """The transcript as a caller may see it.

    `provider_state` is stripped: it is an opaque blob one provider requires
    echoed back, it can be large, and a public contract that carried it would be
    promising to keep a shape no provider guarantees. Everything a reader wants
    -- which tool, with which arguments, in which order, answered by which
    result -- is in what remains.
    """
    calls = message.get("tool_calls")
    if not calls:
        return message

    return {
        **message,
        "tool_calls": [
            {key: value for key, value in call.items() if key != "provider_state"} for call in calls
        ],
    }

"""Flow 7.2 from reference doc 02: an agent run, tools and human approval.

The loop is written out rather than delegated to a graph library. What a graph
would buy here — nodes, branching, its own checkpointer — the platform already
has: the state is `RunState`, persistence is the `Checkpointer` port, and the
branch is one `if`. Adopting a framework would mean wrapping its checkpointer to
satisfy the port that already exists, which is the abstraction paying rent
backwards.

One loop serves both entry points. `start` and `resume` differ only in how the
state is reached; from there both hand off to `_advance`, so the streamed and
the blocking path cannot drift apart.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from agent_runtime.application.dto import (
    ApproveToolCallCommand,
    Caller,
    RunEvent,
    RunView,
    StartRunCommand,
    view_of,
)
from agent_runtime.application.ports import (
    AgentSource,
    Checkpointer,
    ModelClient,
    RunRepository,
    ToolCatalog,
    ToolGateway,
)
from agent_runtime.domain.conversation import (
    allowed_tools,
    assistant_message,
    bind_all,
    declarations_for,
    opening_messages,
    resolve_calls,
)
from agent_runtime.domain.definitions import DEFAULT_MAX_STEPS, AgentDefinition, AvailableTool
from agent_runtime.domain.entities import Run, RunState, RunStatus, ToolCall
from agent_runtime.domain.errors import (
    ApprovalForbiddenError,
    RunNotFoundError,
    RunNotWaitingApprovalError,
)
from agent_runtime.domain.policies import ApprovalPolicy, LoopPolicy
from aia_errors import DomainError
from aia_messaging import EventPublisher, EventType, new_event

SOURCE = "aia-agent-runtime"

#: Said on the turn before the ceiling, so the run ends with an answer instead
#: of with a limit the user has to interpret.
WRAP_UP = (
    "You have no tool calls left. Answer with what you already have, and say "
    "plainly what you could not find out."
)


@dataclass(slots=True)
class RunAgent:
    runs: RunRepository
    checkpointer: Checkpointer
    agents: AgentSource
    catalog: ToolCatalog
    tools: ToolGateway
    model: ModelClient
    events: EventPublisher
    max_steps: int = DEFAULT_MAX_STEPS

    # ---------------------------------------------------------------- start

    async def start(self, command: StartRunCommand) -> AsyncIterator[RunEvent]:
        caller = command.caller
        resolved = await self.agents.resolve(
            agent_id=command.agent_id,
            project_id=caller.project_id,
            access_token=caller.access_token,
        )

        run = Run(
            id=str(uuid.uuid4()),
            agent_id=command.agent_id,
            agent_version=resolved.version,
            thread_id=command.thread_id or str(uuid.uuid4()),
            project_id=caller.project_id,
            principal_id=caller.principal_id,
        )
        run.start()
        await self.runs.save(run)

        state = RunState(
            run_id=run.id,
            project_id=caller.project_id,
            agent_id=run.agent_id,
            agent_version=resolved.version,
            thread_id=run.thread_id,
            messages=opening_messages(resolved.definition, command.input),
            definition=resolved.raw,
        )
        # Checkpointed BEFORE the first call: if the process dies in flight the
        # run exists and can be resumed, instead of vanishing without a trace.
        await self.checkpointer.save(state)

        yield RunEvent(
            "run.started",
            {
                "run_id": run.id,
                "agent_id": run.agent_id,
                "agent_version": resolved.version,
                "thread_id": run.thread_id,
            },
        )

        async for event in self._advance(run, state, resolved.definition, caller):
            yield event

    # --------------------------------------------------------------- resume

    async def resume(self, command: ApproveToolCallCommand) -> AsyncIterator[RunEvent]:
        caller = command.caller
        run = await self.runs.find(command.run_id)
        # A run from another project answers "not found", not "forbidden":
        # confirming it exists hands over information about the neighbour.
        if run is None or run.project_id != caller.project_id:
            raise RunNotFoundError(command.run_id)

        state = await self.checkpointer.load(command.run_id)
        if state is None or not run.is_resumable:
            raise RunNotWaitingApprovalError(command.run_id, command.tool_call_id)
        # The approval names the call it is for. Without this check an approval
        # granted for one call would authorise whatever the run moved on to.
        if not state.is_waiting_approval(command.tool_call_id):
            raise RunNotWaitingApprovalError(command.run_id, command.tool_call_id)

        call = state.pending_call
        assert call is not None  # guaranteed by is_waiting_approval

        if not ApprovalPolicy.can_approve(caller.roles, call):
            raise ApprovalForbiddenError(caller.principal_id, call.risk_level)

        definition = AgentDefinition.from_definition(state.definition)
        run.resume()
        await self.runs.save(run)

        if command.approved:
            async for event in self._invoke(call, state, caller, human_approved=True):
                yield event
        else:
            # A refusal is not an error: it goes back as the result of the call,
            # so the model can say what it could not do instead of the run
            # ending in a way nobody can explain to the user.
            refusal = {
                "status": "denied",
                "reason": command.reason or "A human refused this call.",
            }
            state.record_tool_result(call, refusal)
            yield RunEvent(
                "tool.result",
                {"tool_call_id": call.id, "tool_name": call.tool_name, "status": "denied"},
            )

        async for event in self._drain_queue(state, caller, run):
            yield event
            if run.status == RunStatus.WAITING_APPROVAL:
                return

        await self.checkpointer.save(state)

        async for event in self._advance(run, state, definition, caller):
            yield event

    # ----------------------------------------------------------------- loop

    async def _advance(
        self, run: Run, state: RunState, definition: AgentDefinition, caller: Caller
    ) -> AsyncIterator[RunEvent]:
        try:
            while True:
                tools = allowed_tools(
                    definition,
                    await self.catalog.effective(
                        project_id=caller.project_id, access_token=caller.access_token
                    ),
                )

                if LoopPolicy.last_chance(state.tool_calls_made, self.max_steps):
                    state.messages.append({"role": "system", "content": WRAP_UP})
                    tools = []

                answer: dict[str, Any] = {}
                async for chunk in self._call_model(state, definition, tools, caller):
                    if chunk.get("kind") == "delta":
                        yield RunEvent("message.delta", {"content": chunk.get("content") or ""})
                    else:
                        answer = chunk

                # Bound before any of them runs, so a call held for approval
                # resumes with the store it was shown with.
                calls = bind_all(
                    resolve_calls(answer.get("tool_calls") or [], tools), tools, definition
                )
                state.messages.append(assistant_message(answer.get("content") or "", calls))
                state.step += 1

                if not calls:
                    run.complete(answer.get("content") or "")
                    await self._settle(run, state)
                    yield RunEvent("run.finished", _finished(run, state))
                    return

                state.queued_calls = calls
                async for event in self._drain_queue(state, caller, run):
                    yield event
                await self.checkpointer.save(state)
                if run.status == RunStatus.WAITING_APPROVAL:
                    return

                if LoopPolicy.exhausted(state.tool_calls_made, self.max_steps):
                    run.fail("agent_step_limit")
                    await self._settle(run, state)
                    yield RunEvent("run.finished", _finished(run, state))
                    return
        except DomainError as error:
            run.fail(error.code)
            await self._settle(run, state)
            yield RunEvent("error", {"code": error.code, "message": error.message})
            yield RunEvent("run.finished", _finished(run, state))

    async def _drain_queue(
        self, state: RunState, caller: Caller, run: Run
    ) -> AsyncIterator[RunEvent]:
        """Runs the batch the model asked for, stopping at the first hold."""
        queued = state.take_queued()

        for index, call in enumerate(queued):
            if _needs_approval(call):
                state.hold_for_approval(call, queued[index + 1 :])
                run.request_approval()
                await self.runs.save(run)
                await self.checkpointer.save(state)
                await self._publish_approval(run, call)
                yield RunEvent(
                    "approval.requested",
                    {
                        "run_id": run.id,
                        "tool_call_id": call.id,
                        "tool_name": call.tool_name,
                        "risk_level": call.risk_level,
                        "arguments": call.arguments,
                    },
                )
                return

            async for event in self._invoke(call, state, caller):
                yield event

    async def _invoke(
        self, call: ToolCall, state: RunState, caller: Caller, *, human_approved: bool = False
    ) -> AsyncIterator[RunEvent]:
        yield RunEvent(
            "tool.call",
            {"tool_call_id": call.id, "tool_name": call.tool_name, "arguments": call.arguments},
        )

        refusal = _refusal_for(call)
        if refusal is not None:
            # The model asked for something it cannot have. Telling it so is the
            # useful answer; failing the run would hide a fixable mistake behind
            # a 500.
            state.record_tool_result(call, refusal)
            yield RunEvent(
                "tool.result",
                {
                    "tool_call_id": call.id,
                    "tool_name": call.tool_name,
                    "status": refusal["status"],
                    "result": refusal,
                },
            )
            return

        try:
            result = await self.tools.invoke(
                call=call,
                principal_id=caller.principal_id,
                project_id=caller.project_id,
                access_token=caller.access_token,
                # A person saw these exact arguments and said yes. The gateway
                # holds high-risk calls too; without carrying the decision the
                # two controls deadlock.
                human_approved=human_approved,
            )
            status = "ok"
        except DomainError as error:
            # A refused or failed tool is a fact the model has to reason about,
            # not the end of the run: rate limited, not allowed, endpoint down.
            result = {"status": "failed", "code": error.code, "detail": error.message}
            status = "failed"

        state.record_tool_result(call, result)
        yield RunEvent(
            "tool.result",
            {
                "tool_call_id": call.id,
                "tool_name": call.tool_name,
                "status": status,
                "result": result,
            },
        )

    # -------------------------------------------------------------- helpers

    def _call_model(
        self,
        state: RunState,
        definition: AgentDefinition,
        tools: list[AvailableTool],
        caller: Caller,
    ) -> AsyncIterator[dict[str, Any]]:
        declarations = declarations_for(tools, definition)
        return self.model.stream(
            alias=definition.model_alias,
            messages=state.messages,
            project_id=caller.project_id,
            access_token=caller.access_token,
            tools=declarations or None,
            temperature=definition.temperature,
            top_p=definition.top_p,
            max_tokens=definition.max_output_tokens,
        )

    async def _settle(self, run: Run, state: RunState) -> None:
        await self.checkpointer.save(state)
        await self.runs.save(run)
        await self.events.publish(
            new_event(
                type=EventType.AGENT_RUN_FINISHED,
                source=SOURCE,
                project_id=run.project_id,
                data={
                    "run_id": run.id,
                    "agent_id": run.agent_id,
                    "agent_version": run.agent_version,
                    "thread_id": run.thread_id,
                    "status": run.status.value,
                    "steps": state.step,
                    "tool_calls": state.tool_calls_made,
                    "principal_id": run.principal_id,
                    "error_code": run.error_code,
                },
            )
        )

    # ------------------------------------------------------------- blocking

    async def start_and_wait(self, command: StartRunCommand) -> RunView:
        """The non-streaming endpoint. Same loop, drained instead of forwarded.

        Two implementations of an agent loop would drift, and the one nobody
        watches is the one that drifts.
        """
        return await self._drain(self.start(command))

    async def resume_and_wait(self, command: ApproveToolCallCommand) -> RunView:
        return await self._drain(self.resume(command))

    async def _drain(self, events: AsyncIterator[RunEvent]) -> RunView:
        run_id = ""
        async for event in events:
            if event.kind == "run.started":
                run_id = str(event.data["run_id"])
            elif event.kind in {"approval.requested", "run.finished"}:
                run_id = str(event.data.get("run_id") or run_id)

        return await self.view(run_id)

    async def view(self, run_id: str, *, with_messages: bool = False) -> RunView:
        run = await self.runs.find(run_id)
        state = await self.checkpointer.load(run_id)
        if run is None or state is None:
            raise RunNotFoundError(run_id)
        return view_of(run, state, with_messages=with_messages)

    async def _publish_approval(self, run: Run, call: ToolCall) -> None:
        await self.events.publish(
            new_event(
                type=EventType.APPROVAL_REQUESTED,
                source=SOURCE,
                project_id=run.project_id,
                data={
                    "run_id": run.id,
                    "agent_id": run.agent_id,
                    "tool_call_id": call.id,
                    "tool_name": call.tool_name,
                    "risk_level": call.risk_level,
                    "principal_id": run.principal_id,
                },
            )
        )


def _needs_approval(call: ToolCall) -> bool:
    # Nothing that will not run needs a person to look at it.
    return call.is_resolvable and not call.is_blocked and ApprovalPolicy.requires_approval(call)


def _refusal_for(call: ToolCall) -> dict[str, Any] | None:
    """Why a call will not be sent, if it will not be."""
    if call.blocked_reason is not None:
        return {"status": "blocked", "detail": call.blocked_reason}
    if not call.is_resolvable:
        return {
            "status": "unknown_tool",
            "detail": f"No tool named {call.tool_name!r} is available.",
        }
    return None


def _finished(run: Run, state: RunState) -> dict[str, Any]:
    return {
        "run_id": run.id,
        "status": run.status.value,
        "output": run.output,
        "steps": state.step,
        "tool_calls": state.tool_calls_made,
        "error_code": run.error_code,
    }


__all__ = ["RunAgent", "RunView", "view_of"]

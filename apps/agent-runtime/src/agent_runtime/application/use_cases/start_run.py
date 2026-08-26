"""Starts an agent run.

Minimal version: creates the run, writes the initial checkpoint and calls the
model through the inference-router. The LangGraph graph with steps, tools and
resumption arrives in phase 3.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from agent_runtime.application.dto import RunView, StartRunCommand
from agent_runtime.application.ports import Checkpointer, ModelClient, RunRepository
from agent_runtime.domain.entities import Run, RunState


@dataclass(slots=True)
class StartRun:
    runs: RunRepository
    checkpointer: Checkpointer
    model: ModelClient
    default_alias: str = "chat-fast"

    async def execute(self, command: StartRunCommand) -> RunView:
        run = Run(
            id=str(uuid.uuid4()),
            agent_id=command.agent_id,
            project_id=command.project_id,
            principal_id=command.principal_id,
        )
        run.start()
        await self.runs.save(run)

        state = RunState(
            run_id=run.id,
            project_id=command.project_id,
            messages=[{"role": "user", "content": command.input}],
        )
        # Checkpoint BEFORE the call: if the process dies mid-flight, the run
        # exists and can be resumed instead of vanishing without a trace.
        await self.checkpointer.save(state)

        try:
            answer = await self.model.chat(
                alias=self.default_alias,
                messages=state.messages,
                project_id=command.project_id,
            )
        except Exception as error:
            run.fail(getattr(error, "code", "internal_error"))
            await self.runs.save(run)
            raise

        state.step += 1
        state.messages.append({"role": "assistant", "content": answer.get("content", "")})
        await self.checkpointer.save(state)

        run.complete()
        await self.runs.save(run)

        return RunView(
            id=run.id,
            agent_id=run.agent_id,
            project_id=run.project_id,
            status=run.status.value,
            step=state.step,
        )

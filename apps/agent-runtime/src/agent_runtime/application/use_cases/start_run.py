"""Inicia uma execucao de agente.

Versao minima: cria a execucao, grava o checkpoint inicial e chama o modelo pelo
inference-router. O grafo LangGraph com passos, tools e retomada entra na Fase 3.
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
    default_alias: str = "chat-rapido"

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
        # Checkpoint ANTES da chamada: se o processo morrer no meio, a execucao
        # existe e pode ser retomada, em vez de sumir sem rastro.
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

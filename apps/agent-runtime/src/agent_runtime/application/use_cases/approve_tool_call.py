"""Aprovacao humana de uma tool de risco alto (OWASP LLM06)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.application.dto import ApproveToolCallCommand
from agent_runtime.application.ports import Checkpointer, ToolGateway
from agent_runtime.domain.errors import (
    ApprovalForbiddenError,
    RunNotFoundError,
    RunNotWaitingApprovalError,
)
from agent_runtime.domain.policies import ApprovalPolicy


@dataclass(slots=True)
class ApproveToolCall:
    checkpointer: Checkpointer
    tools: ToolGateway

    async def execute(self, command: ApproveToolCallCommand) -> dict[str, Any]:
        state = await self.checkpointer.load(command.run_id)
        if state is None:
            raise RunNotFoundError(command.run_id)
        if not state.is_waiting_approval(command.tool_call_id):
            raise RunNotWaitingApprovalError(command.run_id)

        call = state.pending_call
        assert call is not None  # garantido por is_waiting_approval

        if not ApprovalPolicy.can_approve(command.principal_roles, call):
            raise ApprovalForbiddenError(command.principal_id, call.risk_level)

        result = await self.tools.invoke(
            call=call,
            principal_id=command.principal_id,
            project_id=state.project_id,
        )

        state.pending_call = None
        state.step += 1
        state.messages.append({"role": "tool", "content": result})
        await self.checkpointer.save(state)
        return result

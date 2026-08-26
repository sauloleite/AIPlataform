"""Aprovacao humana de tool de risco alto (OWASP LLM06)."""

from __future__ import annotations

import pytest

from agent_runtime.application.dto import ApproveToolCallCommand
from agent_runtime.application.use_cases.approve_tool_call import ApproveToolCall
from agent_runtime.domain.entities import RunState, ToolCall
from agent_runtime.domain.errors import (
    ApprovalForbiddenError,
    RunNotFoundError,
    RunNotWaitingApprovalError,
)
from agent_runtime.domain.policies import ApprovalPolicy
from agent_runtime.infrastructure.in_memory import InMemoryCheckpointer, RecordingToolGateway

VIEWER = frozenset({"project_viewer"})
OWNER = frozenset({"project_owner"})


def a_call(risk: str = "high") -> ToolCall:
    return ToolCall(id="call-1", tool_id="gitlab.merge", arguments={"mr": 42}, risk_level=risk)


class TestApprovalPolicy:
    def test_tool_de_risco_alto_exige_aprovacao(self) -> None:
        assert ApprovalPolicy.requires_approval(a_call("high"))

    @pytest.mark.parametrize("risk", ["low", "medium"])
    def test_tool_de_risco_menor_nao_exige(self, risk: str) -> None:
        assert not ApprovalPolicy.requires_approval(a_call(risk))

    def test_viewer_nao_aprova_risco_alto(self) -> None:
        assert not ApprovalPolicy.can_approve(VIEWER, a_call("high"))

    def test_owner_aprova_risco_alto(self) -> None:
        assert ApprovalPolicy.can_approve(OWNER, a_call("high"))

    def test_papel_e_irrelevante_para_risco_baixo(self) -> None:
        assert ApprovalPolicy.can_approve(VIEWER, a_call("low"))

    def test_detecta_auto_aprovacao(self) -> None:
        assert ApprovalPolicy.is_self_approval("user-1", "user-1")
        assert not ApprovalPolicy.is_self_approval("user-1", "user-2")


class TestApproveToolCall:
    @pytest.fixture
    def checkpointer(self) -> InMemoryCheckpointer:
        return InMemoryCheckpointer()

    @pytest.fixture
    def tools(self) -> RecordingToolGateway:
        return RecordingToolGateway()

    @pytest.fixture
    def use_case(
        self, checkpointer: InMemoryCheckpointer, tools: RecordingToolGateway
    ) -> ApproveToolCall:
        return ApproveToolCall(checkpointer=checkpointer, tools=tools)

    async def test_executa_a_tool_quando_o_papel_permite(
        self,
        use_case: ApproveToolCall,
        checkpointer: InMemoryCheckpointer,
        tools: RecordingToolGateway,
    ) -> None:
        await checkpointer.save(
            RunState(run_id="run-1", project_id="proj-1", pending_call=a_call())
        )

        await use_case.execute(
            ApproveToolCallCommand(
                run_id="run-1",
                tool_call_id="call-1",
                principal_id="user-owner",
                principal_roles=OWNER,
            )
        )

        assert len(tools.invocations) == 1
        # A identidade do usuario acompanha a chamada da tool.
        assert tools.invocations[0][1] == "user-owner"
        state = await checkpointer.load("run-1")
        assert state is not None
        assert state.pending_call is None

    async def test_recusa_aprovacao_de_quem_nao_tem_papel(
        self,
        use_case: ApproveToolCall,
        checkpointer: InMemoryCheckpointer,
        tools: RecordingToolGateway,
    ) -> None:
        await checkpointer.save(
            RunState(run_id="run-1", project_id="proj-1", pending_call=a_call())
        )

        with pytest.raises(ApprovalForbiddenError):
            await use_case.execute(
                ApproveToolCallCommand(
                    run_id="run-1",
                    tool_call_id="call-1",
                    principal_id="user-viewer",
                    principal_roles=VIEWER,
                )
            )

        # O ponto do controle: a tool NAO executou.
        assert tools.invocations == []

    async def test_recusa_execucao_inexistente(self, use_case: ApproveToolCall) -> None:
        with pytest.raises(RunNotFoundError):
            await use_case.execute(
                ApproveToolCallCommand(
                    run_id="nao-existe",
                    tool_call_id="call-1",
                    principal_id="user-owner",
                    principal_roles=OWNER,
                )
            )

    async def test_recusa_quando_a_execucao_nao_aguarda_aprovacao(
        self, use_case: ApproveToolCall, checkpointer: InMemoryCheckpointer
    ) -> None:
        await checkpointer.save(RunState(run_id="run-1", project_id="proj-1"))

        with pytest.raises(RunNotWaitingApprovalError):
            await use_case.execute(
                ApproveToolCallCommand(
                    run_id="run-1",
                    tool_call_id="call-1",
                    principal_id="user-owner",
                    principal_roles=OWNER,
                )
            )

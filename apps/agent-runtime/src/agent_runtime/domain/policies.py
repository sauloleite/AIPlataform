"""Politicas puras do runtime.

`ApprovalPolicy` implementa o controle de LLM06 (agencia excessiva) do documento
02: tool de risco alto nao executa sem aprovacao humana, e quem aprova precisa
ter papel para isso.
"""

from __future__ import annotations

from enum import StrEnum

from agent_runtime.domain.entities import ToolCall


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ApprovalPolicy:
    """Regra pura: nao le banco, nao chama servico, nao olha o relogio."""

    #: Papeis que podem aprovar uma tool de risco alto.
    APPROVER_ROLES = frozenset({"project_owner", "platform_admin"})

    @staticmethod
    def requires_approval(call: ToolCall) -> bool:
        return call.risk_level == RiskLevel.HIGH

    @classmethod
    def can_approve(cls, roles: frozenset[str] | set[str], call: ToolCall) -> bool:
        if not cls.requires_approval(call):
            return True
        return bool(cls.APPROVER_ROLES & set(roles))

    @staticmethod
    def is_self_approval(principal_id: str, run_principal_id: str) -> bool:
        """Quem disparou a execucao nao deveria aprovar a propria tool de risco.

        Segregacao de funcoes: a mesma pessoa pedir e autorizar esvazia o
        controle. Quem chama decide se aplica, porque em time pequeno isso
        pode travar a operacao.
        """
        return principal_id == run_principal_id

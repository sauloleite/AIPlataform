"""Dominio dos guardrails.

Regras puras: nada de FastAPI, nada de Presidio, nada de I/O. E o que permite
testar deteccao de CPF e de injecao de prompt sem subir nada.
"""

from guardrails.domain.br_documents import is_valid_cnpj, is_valid_cpf
from guardrails.domain.entities import Decision, Finding, InjectionSignal, InspectionResult
from guardrails.domain.injection import InjectionHeuristics
from guardrails.domain.policy import RedactionStrategy, decide

__all__ = [
    "Decision",
    "Finding",
    "InjectionHeuristics",
    "InjectionSignal",
    "InspectionResult",
    "RedactionStrategy",
    "decide",
    "is_valid_cnpj",
    "is_valid_cpf",
]

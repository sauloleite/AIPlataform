"""The guardrails domain.

Pure rules: no FastAPI, no Presidio, no I/O. That is what makes it possible to
test CPF detection and prompt injection without starting anything.
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

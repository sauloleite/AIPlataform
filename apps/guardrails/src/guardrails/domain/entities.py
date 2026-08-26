"""Entidades e value objects do dominio de guardrails."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class Decision(StrEnum):
    """O que fazer com o conteudo inspecionado."""

    ALLOW = "allow"
    REDACT = "redact"
    BLOCK = "block"


@dataclass(frozen=True, slots=True)
class Finding:
    """Uma ocorrencia de dado sensivel, localizada no texto."""

    entity_type: str
    start: int
    end: int
    score: float

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < self.start:
            msg = "intervalo invalido de finding"
            raise ValueError(msg)
        if not 0.0 <= self.score <= 1.0:
            msg = "score deve ficar entre 0 e 1"
            raise ValueError(msg)

    @property
    def length(self) -> int:
        return self.end - self.start

    def overlaps(self, other: Finding) -> bool:
        return self.start < other.end and other.start < self.end


@dataclass(frozen=True, slots=True)
class InjectionSignal:
    """Uma regra de injecao que disparou, com o trecho que a disparou."""

    rule: str
    score: float
    excerpt: str = ""


@dataclass(frozen=True, slots=True)
class InspectionResult:
    text: str
    findings: tuple[Finding, ...] = ()
    injection_signals: tuple[InjectionSignal, ...] = ()
    decision: Decision = Decision.ALLOW
    redacted_count: int = 0
    metadata: dict[str, str] = field(default_factory=dict)

    @property
    def injection_suspected(self) -> bool:
        return len(self.injection_signals) > 0

    @property
    def injection_score(self) -> float:
        """O maior sinal manda.

        Somar sinais fracos produziria falso positivo em texto longo, que
        naturalmente acumula coincidencias.
        """
        if not self.injection_signals:
            return 0.0
        return max(signal.score for signal in self.injection_signals)

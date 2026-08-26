"""Analisa e devolve o conteudo com a PII substituida.

Chamado pelo inference-router ANTES de qualquer chamada a provedor externo e
antes de qualquer persistencia: e o que garante que o texto bruto nao sai do
fluxo da requisicao (doc 02, secao 10.2).
"""

from __future__ import annotations

from dataclasses import dataclass

from guardrails.application.dto import RedactCommand
from guardrails.application.ports import PiiDetector
from guardrails.domain.entities import Decision, InspectionResult
from guardrails.domain.injection import InjectionHeuristics
from guardrails.domain.policy import apply_redaction, decide


@dataclass(slots=True)
class RedactContent:
    detector: PiiDetector
    heuristics: InjectionHeuristics

    def execute(self, command: RedactCommand) -> InspectionResult:
        findings = tuple(
            self.detector.detect(
                command.text,
                language=command.language,
                entities=list(command.entities) or None,
            )
        )
        signals = self.heuristics.analyze(command.text) if command.check_injection else ()
        decision = decide(findings, signals)

        # Conteudo bloqueado nao e redigido: nao ha versao segura para seguir.
        if decision is Decision.BLOCK:
            return InspectionResult(
                text="",
                findings=findings,
                injection_signals=signals,
                decision=decision,
                metadata=command.metadata,
            )

        redacted, count = apply_redaction(command.text, findings, command.strategy)
        return InspectionResult(
            text=redacted,
            findings=findings,
            injection_signals=signals,
            decision=decision,
            redacted_count=count,
            metadata=command.metadata,
        )

"""Analisa conteudo sem alterar."""

from __future__ import annotations

from dataclasses import dataclass

from guardrails.application.dto import InspectCommand
from guardrails.application.ports import PiiDetector
from guardrails.domain.entities import InspectionResult
from guardrails.domain.injection import InjectionHeuristics
from guardrails.domain.policy import decide


@dataclass(slots=True)
class InspectContent:
    detector: PiiDetector
    heuristics: InjectionHeuristics

    def execute(self, command: InspectCommand) -> InspectionResult:
        findings = tuple(
            self.detector.detect(
                command.text,
                language=command.language,
                entities=list(command.entities) or None,
            )
        )
        signals = self.heuristics.analyze(command.text) if command.check_injection else ()

        return InspectionResult(
            text=command.text,
            findings=findings,
            injection_signals=signals,
            decision=decide(findings, signals),
        )

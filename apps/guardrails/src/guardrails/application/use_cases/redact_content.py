"""Analyses and returns the content with its PII replaced.

Called by the inference-router BEFORE any call to an external provider and
before any persistence: it is what guarantees the raw text never leaves the
request flow (reference doc 02 §10.2).
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

        # Blocked content is not redacted: there is no safe version to carry on with.
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

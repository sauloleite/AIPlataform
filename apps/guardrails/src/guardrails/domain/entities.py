"""Entities and value objects of the guardrails domain."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class Decision(StrEnum):
    """What to do with the inspected content."""

    ALLOW = "allow"
    REDACT = "redact"
    BLOCK = "block"


@dataclass(frozen=True, slots=True)
class Finding:
    """One occurrence of sensitive data, located in the text."""

    entity_type: str
    start: int
    end: int
    score: float

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < self.start:
            msg = "invalid finding range"
            raise ValueError(msg)
        if not 0.0 <= self.score <= 1.0:
            msg = "score must sit between 0 and 1"
            raise ValueError(msg)

    @property
    def length(self) -> int:
        return self.end - self.start

    def overlaps(self, other: Finding) -> bool:
        return self.start < other.end and other.start < self.end


@dataclass(frozen=True, slots=True)
class InjectionSignal:
    """An injection rule that fired, with the excerpt that fired it."""

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
        """The strongest signal wins.

        Summing weak signals would produce false positives on long text, which
        naturally accumulates coincidences.
        """
        if not self.injection_signals:
            return 0.0
        return max(signal.score for signal in self.injection_signals)

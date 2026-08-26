"""Commands and results. No HTTP detail."""

from __future__ import annotations

from dataclasses import dataclass, field

from guardrails.domain.policy import RedactionStrategy


@dataclass(frozen=True, slots=True)
class InspectCommand:
    text: str
    project_id: str
    language: str = "pt"
    entities: tuple[str, ...] = ()
    check_injection: bool = True


@dataclass(frozen=True, slots=True)
class RedactCommand:
    text: str
    project_id: str
    language: str = "pt"
    entities: tuple[str, ...] = ()
    check_injection: bool = True
    strategy: RedactionStrategy = RedactionStrategy.REPLACE
    metadata: dict[str, str] = field(default_factory=dict)

"""Detector with no language-model dependency.

It exists for two reasons: it is the fallback when the spaCy model has not been
downloaded (first `docker compose up`, lightweight CI), and it is the detector
used by the domain tests, which have to be deterministic.

It finds what pattern-plus-validation can settle: CPF, CNPJ, card, email, phone
and IP. It does NOT find a PERSON NAME, which needs a model -- the difference is
documented so nobody confuses the two modes.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Final

from guardrails.domain.br_documents import is_valid_cnpj, is_valid_cpf, luhn_is_valid
from guardrails.domain.entities import Finding

_PATTERNS: Final[tuple[tuple[str, re.Pattern[str], float], ...]] = (
    ("BR_CPF", re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b"), 0.9),
    ("BR_CNPJ", re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b"), 0.9),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b"), 0.85),
    ("EMAIL_ADDRESS", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), 0.95),
    (
        "PHONE_NUMBER",
        re.compile(r"\b(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b"),
        0.7,
    ),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), 0.8),
)

_VALIDATORS: Final[dict[str, object]] = {
    "BR_CPF": is_valid_cpf,
    "BR_CNPJ": is_valid_cnpj,
    "CREDIT_CARD": luhn_is_valid,
}

SUPPORTED: Final[tuple[str, ...]] = tuple(entity for entity, _, _ in _PATTERNS)


class RegexPiiDetector:
    """Deterministic adapter for the `PiiDetector` port."""

    @property
    def supported_entities(self) -> Sequence[str]:
        return SUPPORTED

    def detect(
        self, text: str, *, language: str = "pt", entities: Sequence[str] | None = None
    ) -> Sequence[Finding]:
        _ = language
        wanted = set(entities) if entities else None
        findings: list[Finding] = []

        for entity_type, pattern, score in _PATTERNS:
            if wanted is not None and entity_type not in wanted:
                continue

            for match in pattern.finditer(text):
                candidate = match.group(0)
                validator = _VALIDATORS.get(entity_type)
                if callable(validator) and not validator(candidate):
                    continue
                findings.append(
                    Finding(
                        entity_type=entity_type,
                        start=match.start(),
                        end=match.end(),
                        score=score,
                    )
                )

        # Sorts and resolves overlaps by highest score: an IP inside a phone
        # number must not produce two findings.
        findings.sort(key=lambda finding: (finding.start, -finding.score))
        deduped: list[Finding] = []
        for finding in findings:
            if any(finding.overlaps(existing) for existing in deduped):
                continue
            deduped.append(finding)
        return tuple(deduped)

"""PII detector on top of Presidio, with Brazilian recognisers.

Presidio ships no CPF, CNPJ or branch/account recogniser, and those are exactly
the data that matter most under LGPD at a financial institution. Each recogniser
pairs a pattern with check-digit VALIDATION, because a regex on its own turns a
ticket number into a false positive.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any, Final

from guardrails.domain.br_documents import is_valid_cnpj, is_valid_cpf, luhn_is_valid
from guardrails.domain.entities import Finding

logger = logging.getLogger(__name__)

CPF_PATTERN: Final = r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b"
CNPJ_PATTERN: Final = r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b"
BANK_ACCOUNT_PATTERN: Final = (
    r"\b(ag(encia|ência)?\.?\s*:?\s*\d{4}[-\s]?\d?)|(c\.?c\.?\s*:?\s*\d{4,12}-?\d)\b"
)

DEFAULT_ENTITIES: Final[tuple[str, ...]] = (
    "BR_CPF",
    "BR_CNPJ",
    "BR_BANK_ACCOUNT",
    "CREDIT_CARD",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "PERSON",
    "LOCATION",
    "IP_ADDRESS",
    "IBAN_CODE",
    "URL",
)

MIN_SCORE: Final = 0.4


def _build_br_recognizers() -> list[Any]:
    from presidio_analyzer import Pattern, PatternRecognizer

    class CpfRecognizer(PatternRecognizer):
        def __init__(self) -> None:
            super().__init__(
                supported_entity="BR_CPF",
                supported_language="pt",
                patterns=[Pattern("cpf", CPF_PATTERN, 0.5)],
                context=["cpf", "documento", "contribuinte"],
            )

        def validate_result(self, pattern_text: str) -> bool | None:
            # Raises confidence when the check digit matches and drops the
            # result when it does not: that is what separates a CPF from a
            # ticket number.
            return is_valid_cpf(pattern_text)

    class CnpjRecognizer(PatternRecognizer):
        def __init__(self) -> None:
            super().__init__(
                supported_entity="BR_CNPJ",
                supported_language="pt",
                patterns=[Pattern("cnpj", CNPJ_PATTERN, 0.5)],
                context=["cnpj", "empresa", "razao social"],
            )

        def validate_result(self, pattern_text: str) -> bool | None:
            return is_valid_cnpj(pattern_text)

    class BankAccountRecognizer(PatternRecognizer):
        def __init__(self) -> None:
            super().__init__(
                supported_entity="BR_BANK_ACCOUNT",
                supported_language="pt",
                patterns=[Pattern("agencia_conta", BANK_ACCOUNT_PATTERN, 0.6)],
                context=["agencia", "conta", "banco", "corrente", "poupanca"],
            )

    return [CpfRecognizer(), CnpjRecognizer(), BankAccountRecognizer()]


class PresidioDetector:
    """Presidio adapter for the `PiiDetector` port."""

    def __init__(self, *, languages: Sequence[str] = ("pt", "en")) -> None:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        provider = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [
                    {"lang_code": lang, "model_name": _model_for(lang)} for lang in languages
                ],
            }
        )
        self._engine = AnalyzerEngine(
            nlp_engine=provider.create_engine(), supported_languages=list(languages)
        )
        for recognizer in _build_br_recognizers():
            self._engine.registry.add_recognizer(recognizer)

    @property
    def supported_entities(self) -> Sequence[str]:
        return DEFAULT_ENTITIES

    def detect(
        self, text: str, *, language: str, entities: Sequence[str] | None = None
    ) -> Sequence[Finding]:
        if not text.strip():
            return ()

        results = self._engine.analyze(
            text=text,
            language=language,
            entities=list(entities) if entities else list(DEFAULT_ENTITIES),
            score_threshold=MIN_SCORE,
        )

        findings: list[Finding] = []
        for result in results:
            # A card goes through Luhn: 16 digits that fail Luhn are usually
            # an order number, not a card.
            if result.entity_type == "CREDIT_CARD" and not luhn_is_valid(
                text[result.start : result.end]
            ):
                continue
            findings.append(
                Finding(
                    entity_type=result.entity_type,
                    start=result.start,
                    end=result.end,
                    score=float(result.score),
                )
            )
        return tuple(findings)


def _model_for(language: str) -> str:
    return {"pt": "pt_core_news_sm", "en": "en_core_web_sm"}.get(language, "en_core_web_sm")

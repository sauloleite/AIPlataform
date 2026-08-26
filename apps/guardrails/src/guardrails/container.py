"""Dependency composition.

All the wiring lives here, never inside a use case (reference doc 03 §3.3).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache

from aia_auth import JwtVerifier
from guardrails.application.ports import PiiDetector
from guardrails.application.use_cases.inspect_content import InspectContent
from guardrails.application.use_cases.redact_content import RedactContent
from guardrails.config import Settings, get_settings
from guardrails.domain.injection import InjectionHeuristics
from guardrails.infrastructure.regex_detector import RegexPiiDetector

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Container:
    settings: Settings
    detector: PiiDetector
    inspect: InspectContent
    redact: RedactContent
    verifier: JwtVerifier
    detector_name: str


def _build_detector(settings: Settings) -> tuple[PiiDetector, str]:
    if settings.detector == "regex":
        return RegexPiiDetector(), "regex"

    try:
        from guardrails.infrastructure.presidio_detector import PresidioDetector

        return PresidioDetector(), "presidio"
    except Exception:
        # A missing spaCy model is the common case on first boot. Degrading to
        # regex keeps CPF, CNPJ and card redaction working; what is lost is
        # person-name detection. Better than starting with no guardrail at all.
        logger.warning(
            "Presidio unavailable (missing spaCy model?); falling back to the regex "
            "detector. Person names will NOT be detected."
        )
        return RegexPiiDetector(), "regex-fallback"


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    detector, detector_name = _build_detector(settings)
    heuristics = InjectionHeuristics()

    return Container(
        settings=settings,
        detector=detector,
        detector_name=detector_name,
        inspect=InspectContent(detector=detector, heuristics=heuristics),
        redact=RedactContent(detector=detector, heuristics=heuristics),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )

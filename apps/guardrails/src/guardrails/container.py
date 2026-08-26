"""Composicao de dependencias.

Todo o wiring vive aqui, nunca dentro de um caso de uso (doc 03, secao 3.3).
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
        # Modelo do spaCy ausente e o caso comum no primeiro boot. Degradar para
        # regex mantem a redacao de CPF, CNPJ e cartao funcionando; o que se
        # perde e a deteccao de nome de pessoa. Melhor do que subir sem guardrail.
        logger.warning(
            "Presidio indisponivel (modelo do spaCy ausente?); usando detector por regex. "
            "Nome de pessoa NAO sera detectado."
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

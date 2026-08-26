"""Composicao de dependencias. Nunca dentro de um caso de uso."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from aia_auth import JwtVerifier
from evaluation.application.use_cases.exemplo import ExecutarExemplo
from evaluation.config import Settings, get_settings
from evaluation.infrastructure.in_memory import InMemoryExemploRepository


@dataclass(slots=True)
class Container:
    settings: Settings
    exemplo: ExecutarExemplo
    verifier: JwtVerifier


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    return Container(
        settings=settings,
        exemplo=ExecutarExemplo(repository=InMemoryExemploRepository()),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )

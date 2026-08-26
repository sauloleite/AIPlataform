"""Dependency composition. Never inside a use case."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from aia_auth import JwtVerifier
from evaluation.application.use_cases.example import RunExample
from evaluation.config import Settings, get_settings
from evaluation.infrastructure.in_memory import InMemoryExampleRepository


@dataclass(slots=True)
class Container:
    settings: Settings
    example: RunExample
    verifier: JwtVerifier


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    return Container(
        settings=settings,
        example=RunExample(repository=InMemoryExampleRepository()),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )

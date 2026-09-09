"""Configuration validated at startup. 12-factor."""

from __future__ import annotations

from functools import lru_cache

from aia_fastapi import PlatformSettings


class Settings(PlatformSettings):
    port: int = 8001

    # `regex` needs no language model and starts instantly; `presidio` also
    # detects person names and locations, at the cost of spaCy.
    detector: str = "presidio"
    default_language: str = "pt"
    block_threshold: float = 0.8


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

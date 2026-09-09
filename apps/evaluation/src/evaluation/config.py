"""Configuration validated at startup. 12-factor.

The service does not start on invalid configuration. What it CAN start without
is a judge: a suite that needs one then refuses to run rather than scoring
nothing, which is the failure everyone wants and nobody gets.
"""

from __future__ import annotations

from functools import lru_cache

from aia_fastapi import PlatformSettings


class Settings(PlatformSettings):
    port: int = 8003

    inference_router_url: str = "http://inference-router:3000"
    guardrails_url: str = "http://guardrails:8001"

    mongo_uri: str = "mongodb://mongo:27017"
    mongo_database: str = "aia_evaluation"
    redis_url: str = "redis://redis:6379"

    #: Where the suites live, relative to the repository root.
    suites_path: str = "evals/suites"

    #: The alias that GRADES. Empty disables the judged evaluators, and a suite
    #: that names one then refuses to run.
    #:
    #: It should not be the alias under test: a model asked to grade itself
    #: agrees with itself.
    judge_alias: str = ""


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

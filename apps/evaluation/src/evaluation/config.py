"""Configuration validated at startup. 12-factor.

The service does not start on invalid configuration. What it CAN start without
is a judge: a suite that needs one then refuses to run rather than scoring
nothing, which is the failure everyone wants and nobody gets.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    node_env: str = "development"
    port: int = 8003
    log_level: str = "info"

    identity_issuer: str = "http://identity:3001"
    identity_audience: str = "aia-platform"
    identity_jwks_url: str | None = None

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

    otel_exporter_otlp_endpoint: str | None = None

    @property
    def jwks_url(self) -> str:
        return self.identity_jwks_url or f"{self.identity_issuer}/.well-known/jwks.json"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

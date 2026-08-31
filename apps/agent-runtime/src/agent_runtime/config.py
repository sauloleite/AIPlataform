"""Configuration validated at startup.

The application does not start on invalid configuration: a runtime that boots
without knowing where the registry is would fail on the first run instead, with
a 500 nobody can read.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    node_env: str = "development"
    port: int = 8002
    log_level: str = "info"

    identity_issuer: str = "http://identity:3001"
    identity_audience: str = "aia-platform"
    identity_jwks_url: str | None = None

    inference_router_url: str = "http://inference-router:3000"
    registry_url: str = "http://registry:3004"
    mcp_gateway_url: str = "http://mcp-gateway:3006"

    mongo_uri: str = "mongodb://mongo:27017"
    mongo_database: str = "aia_agent_runtime"
    redis_url: str = "redis://redis:6379"

    #: The ceiling on tool calls in one run. A runaway loop spends real money.
    agent_max_steps: int = 12
    #: The gap allowed between two chunks of a model stream, not the length of
    #: the answer. A local model on a cold start can be slow to the first token.
    model_read_timeout_seconds: float = 180.0

    otel_exporter_otlp_endpoint: str | None = None

    @property
    def jwks_url(self) -> str:
        return self.identity_jwks_url or f"{self.identity_issuer}/.well-known/jwks.json"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

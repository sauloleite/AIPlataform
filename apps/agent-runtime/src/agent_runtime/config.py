"""Configuration validated at startup.

The application does not start on invalid configuration: a runtime that boots
without knowing where the registry is would fail on the first run instead, with
a 500 nobody can read.
"""

from __future__ import annotations

from functools import lru_cache

from aia_fastapi import PlatformSettings


class Settings(PlatformSettings):
    port: int = 8002

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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

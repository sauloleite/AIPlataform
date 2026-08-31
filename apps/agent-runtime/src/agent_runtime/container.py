"""Dependency composition. Never inside a use case.

The only place that knows all three layers at once. Everything above it sees
ports, so swapping Mongo for something else is a change here and nowhere else.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import redis.asyncio as redis

from agent_runtime.application.use_cases.run_agent import RunAgent
from agent_runtime.config import Settings, get_settings
from agent_runtime.infrastructure.mongo import (
    MongoCheckpointer,
    MongoRunRepository,
    ensure_indexes,
    mongo_client,
)
from agent_runtime.infrastructure.platform_clients import (
    HttpAgentSource,
    HttpToolCatalog,
    HttpToolGateway,
)
from agent_runtime.infrastructure.router_client import HttpModelClient
from aia_auth import JwtVerifier
from aia_messaging import RedisStreamPublisher


@dataclass(slots=True)
class Container:
    settings: Settings
    run_agent: RunAgent
    verifier: JwtVerifier
    _database: Any

    async def start(self) -> None:
        await ensure_indexes(self._database)

    async def ready(self) -> bool:
        await self._database.command("ping")
        return True


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()

    database = mongo_client(settings.mongo_uri)[settings.mongo_database]

    return Container(
        settings=settings,
        _database=database,
        run_agent=RunAgent(
            runs=MongoRunRepository(database),
            checkpointer=MongoCheckpointer(database),
            agents=HttpAgentSource(base_url=settings.registry_url),
            catalog=HttpToolCatalog(base_url=settings.mcp_gateway_url),
            tools=HttpToolGateway(base_url=settings.mcp_gateway_url),
            model=HttpModelClient(
                base_url=settings.inference_router_url,
                read_timeout_seconds=settings.model_read_timeout_seconds,
            ),
            events=RedisStreamPublisher(redis=redis.from_url(settings.redis_url)),
            max_steps=settings.agent_max_steps,
        ),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )

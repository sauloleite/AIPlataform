"""FastAPI application for aia-agent-runtime."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from agent_runtime.config import get_settings
from agent_runtime.container import get_container
from agent_runtime.presentation.http.routes import health, router, runs_router
from aia_fastapi import create_app as create_platform_app

logger = logging.getLogger(__name__)


async def _connect() -> None:
    await get_container().start()
    logger.info("agent-runtime ready on port %d", get_settings().port)


def create_app() -> FastAPI:
    return create_platform_app(
        service_name="aia-agent-runtime",
        title="AIA Agent Runtime",
        settings=get_settings(),
        routers=(router, runs_router, health),
        on_startup=_connect,
    )


app = create_app()

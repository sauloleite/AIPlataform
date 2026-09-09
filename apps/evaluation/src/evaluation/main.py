"""FastAPI application for aia-evaluation."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from aia_fastapi import create_app as create_platform_app
from evaluation.config import get_settings
from evaluation.container import get_container
from evaluation.presentation.http.routes import health, router

logger = logging.getLogger(__name__)


async def _connect() -> None:
    await get_container().start()
    logger.info("evaluation ready on port %d", get_settings().port)


def create_app() -> FastAPI:
    return create_platform_app(
        service_name="aia-evaluation",
        title="AIA Evaluation",
        settings=get_settings(),
        routers=(router, health),
        on_startup=_connect,
    )


app = create_app()

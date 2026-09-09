"""FastAPI application for aia-guardrails."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from aia_fastapi import create_app as create_platform_app
from guardrails.config import get_settings
from guardrails.container import get_container
from guardrails.presentation.http.routes import health, router

logger = logging.getLogger(__name__)


async def _warm_up() -> None:
    # Loads the detector at boot: failing here is cheap, failing on the first
    # production request is not.
    container = get_container()
    logger.info("guardrails ready with the %s detector", container.detector_name)


def create_app() -> FastAPI:
    return create_platform_app(
        service_name="aia-guardrails",
        title="AIA Guardrails",
        description="PII redaction and prompt injection detection",
        settings=get_settings(),
        routers=(router, health),
        on_startup=_warm_up,
    )


app = create_app()

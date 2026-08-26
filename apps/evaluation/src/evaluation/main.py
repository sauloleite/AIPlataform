"""FastAPI application for aia-evaluation."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from aia_errors import PROBLEM_CONTENT_TYPE, DomainError, problem_from_unknown
from aia_telemetry import current_trace_id, start_telemetry
from evaluation.config import get_settings
from evaluation.presentation.http.routes import health_router, router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    _ = app
    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())
    start_telemetry("aia-evaluation")
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="AIA Evaluation", version="1.0.0", lifespan=lifespan)

    @app.exception_handler(DomainError)
    async def handle_domain_error(request: Request, error: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content=error.to_problem(instance=request.url.path, trace_id=current_trace_id()),
            media_type=PROBLEM_CONTENT_TYPE,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, error: Exception) -> JSONResponse:
        # Stack in the log, correlated by trace_id; never in the response.
        logger.exception("request failed at %s", request.url.path)
        problem = problem_from_unknown(
            error, instance=request.url.path, trace_id=current_trace_id()
        )
        return JSONResponse(
            status_code=problem["status"], content=problem, media_type=PROBLEM_CONTENT_TYPE
        )

    app.include_router(router)
    app.include_router(health_router)
    return app


app = create_app()

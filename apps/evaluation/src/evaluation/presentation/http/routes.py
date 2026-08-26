"""Routers FastAPI. So adaptam entrada e saida."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header

from aia_auth import Principal, bearer_token, require_membership
from aia_errors import ProjectRequiredError
from aia_telemetry import AiaAttr, annotate_active_span
from evaluation.application.dto import ExemploCommand
from evaluation.container import get_container

router = APIRouter(prefix="/v1/evaluation", tags=["evaluation"])
health_router = APIRouter(prefix="/health", tags=["health"])


def _authenticate(
    authorization: Annotated[str | None, Header()] = None,
    x_project_id: Annotated[str | None, Header()] = None,
) -> tuple[Principal, str]:
    """`Depends` so existe na apresentacao (doc 03, secao 3.3)."""
    principal = get_container().verifier.verify(bearer_token(authorization))
    if not x_project_id:
        raise ProjectRequiredError()
    if principal.type != "service":
        require_membership(principal, x_project_id)

    annotate_active_span(**{AiaAttr.PROJECT_ID: x_project_id, AiaAttr.PRINCIPAL_ID: principal.id})
    return principal, x_project_id


Authenticated = Annotated[tuple[Principal, str], Depends(_authenticate)]


@router.get("")
async def listar(auth: Authenticated) -> dict[str, str]:
    _, project_id = auth
    exemplo = await get_container().exemplo.execute(ExemploCommand(project_id=project_id))
    return {"id": exemplo.id, "project_id": exemplo.project_id}


@health_router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@health_router.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ok"}

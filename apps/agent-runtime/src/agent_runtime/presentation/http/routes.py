"""Routers FastAPI do agent-runtime."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from agent_runtime.application.dto import ApproveToolCallCommand, StartRunCommand
from agent_runtime.container import get_container
from agent_runtime.domain.errors import RunNotFoundError
from aia_auth import Principal, bearer_token, require_membership
from aia_errors import ProjectRequiredError
from aia_telemetry import AiaAttr, annotate_active_span

router = APIRouter(prefix="/v1/agents", tags=["agents"])
runs_router = APIRouter(prefix="/v1/runs", tags=["agents"])
health_router = APIRouter(prefix="/health", tags=["health"])


class StartRunBody(BaseModel):
    input: str = Field(min_length=1, max_length=100_000)


class RunResponse(BaseModel):
    id: str
    agent_id: str
    project_id: str
    status: str
    step: int


def _authenticate(
    authorization: Annotated[str | None, Header()] = None,
    x_project_id: Annotated[str | None, Header()] = None,
) -> tuple[Principal, str]:
    container = get_container()
    principal = container.verifier.verify(bearer_token(authorization))
    if not x_project_id:
        raise ProjectRequiredError()
    if principal.type != "service":
        require_membership(principal, x_project_id)

    annotate_active_span(**{AiaAttr.PROJECT_ID: x_project_id, AiaAttr.PRINCIPAL_ID: principal.id})
    return principal, x_project_id


Authenticated = Annotated[tuple[Principal, str], Depends(_authenticate)]


@router.post("/{agent_id}/runs", response_model=RunResponse, status_code=201)
async def start_run(agent_id: str, body: StartRunBody, auth: Authenticated) -> RunResponse:
    principal, project_id = auth
    result = await get_container().start_run.execute(
        StartRunCommand(
            agent_id=agent_id,
            project_id=project_id,
            principal_id=principal.id,
            input=body.input,
        )
    )
    return RunResponse(**result.__dict__)


@runs_router.get("/{run_id}", response_model=RunResponse)
async def get_run(run_id: str, auth: Authenticated) -> RunResponse:
    _, project_id = auth
    run = await get_container().runs.find(run_id)
    # Execucao de outro projeto responde 404, e nao 403: confirmar a existencia
    # entregaria informacao sobre o tenant vizinho.
    if run is None or run.project_id != project_id:
        raise RunNotFoundError(run_id)

    return RunResponse(
        id=run.id,
        agent_id=run.agent_id,
        project_id=run.project_id,
        status=run.status.value,
        step=0,
    )


@runs_router.post("/{run_id}/approve", status_code=200)
async def approve(run_id: str, tool_call_id: str, auth: Authenticated) -> dict[str, object]:
    principal, project_id = auth
    _ = project_id
    return await get_container().approve_tool_call.execute(
        ApproveToolCallCommand(
            run_id=run_id,
            tool_call_id=tool_call_id,
            principal_id=principal.id,
            principal_roles=frozenset(principal.roles_in(project_id)),
        )
    )


@health_router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@health_router.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ok"}

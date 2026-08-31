"""FastAPI routers for the agent-runtime.

The controller only adapts input and output. Its one piece of logic of its own
is the SSE protocol, which is a transport detail.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agent_runtime.application.dto import (
    ApproveToolCallCommand,
    Caller,
    RunView,
    StartRunCommand,
)
from agent_runtime.container import get_container
from agent_runtime.domain.errors import RunNotFoundError
from agent_runtime.presentation.http.sse import SSE_HEADERS, sse_stream
from aia_auth import Principal, bearer_token, require_membership
from aia_errors import ProjectRequiredError
from aia_telemetry import AiaAttr, annotate_active_span

router = APIRouter(prefix="/v1/agents", tags=["runs"])
runs_router = APIRouter(prefix="/v1/runs", tags=["runs"])
health_router = APIRouter(prefix="/health", tags=["health"])


class StartRunBody(BaseModel):
    input: str = Field(min_length=1, max_length=100_000)
    thread_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ApprovalBody(BaseModel):
    tool_call_id: str = Field(min_length=1)
    approved: bool = True
    reason: str | None = Field(default=None, max_length=2000)


def _authenticate(
    authorization: Annotated[str | None, Header()] = None,
    x_project_id: Annotated[str | None, Header()] = None,
) -> Caller:
    container = get_container()
    token = bearer_token(authorization)
    principal = container.verifier.verify(token)
    if not x_project_id:
        raise ProjectRequiredError()
    if principal.type != "service":
        require_membership(principal, x_project_id)

    annotate_active_span(**{AiaAttr.PROJECT_ID: x_project_id, AiaAttr.PRINCIPAL_ID: principal.id})
    return _caller_of(principal, x_project_id, token)


def _caller_of(principal: Principal, project_id: str, token: str) -> Caller:
    return Caller(
        principal_id=principal.id,
        project_id=project_id,
        # The caller's own token travels with every outbound call: the registry,
        # the gateway and the router each authorise the PERSON (ADR-017).
        access_token=token,
        roles=frozenset(principal.roles_in(project_id)),
    )


Authenticated = Annotated[Caller, Depends(_authenticate)]


def _run_response(view: RunView, *, with_messages: bool = False) -> dict[str, Any]:
    return {
        "id": view.id,
        "agent_id": view.agent_id,
        "agent_version": view.agent_version,
        "thread_id": view.thread_id,
        "project_id": view.project_id,
        "principal_id": view.principal_id,
        "status": view.status,
        "step": view.step,
        "output": view.output,
        "pending_call": _call_response(view),
        "error_code": view.error_code,
        "created_at": view.created_at,
        "finished_at": view.finished_at,
        **({"messages": view.messages} if with_messages else {}),
    }


def _call_response(view: RunView) -> dict[str, Any] | None:
    call = view.pending_call
    if call is None:
        return None
    return {
        "id": call.id,
        "tool_name": call.tool_name,
        "tool_id": call.tool_id,
        "arguments": call.arguments,
        "risk_level": call.risk_level,
    }


@router.post("/{agent_id}/runs")
async def start_run(
    agent_id: str,
    body: StartRunBody,
    caller: Authenticated,
    response: Response,
    stream: Annotated[bool, Query()] = False,
) -> Any:
    command = StartRunCommand(
        agent_id=agent_id,
        caller=caller,
        input=body.input,
        thread_id=body.thread_id,
        metadata=body.metadata,
    )
    run_agent = get_container().run_agent

    if stream:
        return StreamingResponse(
            sse_stream(run_agent.start(command), f"/v1/agents/{agent_id}/runs"),
            headers=SSE_HEADERS,
        )

    view = await run_agent.start_and_wait(command)
    response.status_code = 201
    return _run_response(view)


@runs_router.get("/{run_id}")
async def get_run(run_id: str, caller: Authenticated) -> dict[str, Any]:
    view = await get_container().run_agent.view(run_id, with_messages=True)
    # A run from another project answers 404, not 403: confirming it exists
    # would hand over information about the neighbouring tenant.
    if view.project_id != caller.project_id:
        raise RunNotFoundError(run_id)
    return _run_response(view, with_messages=True)


@runs_router.post("/{run_id}/approve")
async def approve(
    run_id: str,
    body: ApprovalBody,
    caller: Authenticated,
    stream: Annotated[bool, Query()] = False,
) -> Any:
    command = ApproveToolCallCommand(
        run_id=run_id,
        tool_call_id=body.tool_call_id,
        caller=caller,
        approved=body.approved,
        reason=body.reason,
    )
    run_agent = get_container().run_agent

    if stream:
        return StreamingResponse(
            sse_stream(run_agent.resume(command), f"/v1/runs/{run_id}/approve"),
            headers=SSE_HEADERS,
        )

    return _run_response(await run_agent.resume_and_wait(command))


@health_router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@health_router.get("/ready")
async def ready() -> dict[str, str]:
    await get_container().ready()
    return {"status": "ok"}

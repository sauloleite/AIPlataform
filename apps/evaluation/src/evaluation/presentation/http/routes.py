"""FastAPI routers. They only adapt input and output."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field

from aia_auth import Principal
from aia_fastapi import AuthenticatedCaller, authenticated, health_router
from evaluation.application.dto import Caller, RunSuiteCommand
from evaluation.container import get_container
from evaluation.domain.entities import EvaluationRun
from evaluation.domain.errors import RunNotFoundError

router = APIRouter(prefix="/v1/evaluations", tags=["evaluation"])

MAX_LIMIT = 100


class StartRunBody(BaseModel):
    suite: str | None = Field(default=None, description="A suite file or a directory.")
    alias: str | None = Field(default=None, description="Overrides the alias each suite names.")


def _caller_of(principal: Principal, project_id: str, token: str) -> Caller:
    return Caller(
        principal_id=principal.id,
        project_id=project_id,
        # An evaluation spends real inference, and it spends it against the
        # project whose quality is being measured (ADR-017).
        access_token=token,
    )


def _caller(
    identity: Annotated[AuthenticatedCaller, authenticated(lambda: get_container().verifier)],
) -> Caller:
    return _caller_of(identity.principal, identity.project_id, identity.token)


Authenticated = Annotated[Caller, Depends(_caller)]


def _run_response(run: EvaluationRun, *, with_cases: bool = False) -> dict[str, Any]:
    return {
        "id": run.id,
        "project_id": run.project_id,
        "suite": run.suite,
        "alias": run.alias,
        "principal_id": run.principal_id,
        "status": run.status.value,
        "error_code": run.error_code,
        "started_at": run.started_at.isoformat().replace("+00:00", "Z"),
        "finished_at": (
            run.finished_at.isoformat().replace("+00:00", "Z")
            if run.finished_at is not None
            else None
        ),
        "metrics": [
            {
                "evaluator": metric.evaluator,
                "value": round(metric.value, 4),
                "threshold": metric.threshold,
                "maximum": metric.maximum,
                "passed": metric.passed,
                "sample_size": metric.sample_size,
            }
            for metric in run.metrics
        ],
        **(
            {
                "cases": [
                    {
                        "case_id": result.case.id,
                        "input": result.case.input,
                        "answer": None if result.answer is None else result.answer.text,
                        "error_code": result.error_code,
                        "scores": result.scores,
                    }
                    for result in run.results
                ]
            }
            if with_cases
            else {}
        ),
    }


@router.post("", status_code=202)
async def start_run(body: StartRunBody, caller: Authenticated, response: Response) -> Any:
    """Runs the suites and answers with what they measured.

    202 rather than 201: a suite is real inference against real cases, and the
    caller is being told the work happened, not that a resource was created.
    """
    container = get_container()
    runs = await container.run_suite.execute(
        RunSuiteCommand(
            suite_path=body.suite or container.settings.suites_path,
            caller=caller,
            alias=body.alias,
        )
    )
    # The gate, on the wire: a caller that only reads the status still learns
    # whether this run should stop a merge.
    response.status_code = 409 if any(run.gated for run in runs) else 202
    return {"items": [_run_response(run) for run in runs]}


@router.get("")
async def list_runs(
    caller: Authenticated, limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 25
) -> dict[str, Any]:
    runs = await get_container().runs.list(caller.project_id, limit=limit)
    return {"items": [_run_response(run) for run in runs], "next_cursor": None}


@router.get("/{run_id}")
async def get_run(run_id: str, caller: Authenticated) -> dict[str, Any]:
    run = await get_container().runs.find(caller.project_id, run_id)
    # A run from another project answers 404, not 403: confirming it exists
    # would hand over information about the neighbouring tenant.
    if run is None:
        raise RunNotFoundError(run_id)
    return _run_response(run, with_cases=True)


async def _ready() -> dict[str, str]:
    await get_container().ready()
    return {"status": "ok"}


health = health_router(ready=_ready)

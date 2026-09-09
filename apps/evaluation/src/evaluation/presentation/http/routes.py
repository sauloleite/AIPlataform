"""FastAPI routers. They only adapt input and output."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field

from aia_auth import Principal
from aia_fastapi import AuthenticatedCaller, authenticated, health_router
from evaluation.application.dto import Caller, RunSuiteCommand
from evaluation.application.use_cases.annotate import RecordAnnotationCommand
from evaluation.container import get_container
from evaluation.domain.annotation import Annotation
from evaluation.domain.entities import EvaluationRun
from evaluation.domain.errors import RunNotFoundError
from evaluation.domain.sampling import summarise

router = APIRouter(prefix="/v1/evaluations", tags=["evaluation"])
annotations_router = APIRouter(prefix="/v1/annotations", tags=["evaluation"])
samples_router = APIRouter(prefix="/v1/samples", tags=["evaluation"])

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


class AnnotationBody(BaseModel):
    """What the console posts after somebody reads a trace.

    The text fields are optional because content capture is per project and off
    by default: most annotations are a verdict about a trace whose words the
    platform never stored, and requiring them would mean either an empty string
    or no annotation at all.
    """

    trace_id: str = Field(description="The trace this is about.")
    verdict: str = Field(description="good or bad.")
    failure_mode: str = Field(default="", description="Required when the verdict is bad.")
    note: str = ""
    evaluator: str = Field(default="", description="Which evaluator should have caught it.")
    question: str = ""
    answer: str = ""
    context: list[str] = Field(default_factory=list)


def _annotation_response(annotation: Annotation) -> dict[str, Any]:
    return {
        "id": annotation.id,
        "project_id": annotation.project_id,
        "trace_id": annotation.trace_id,
        "verdict": annotation.verdict.value,
        "failure_mode": annotation.failure_mode,
        "note": annotation.note or None,
        "evaluator": annotation.evaluator,
        "question": annotation.question or None,
        "answer": annotation.answer or None,
        "context": list(annotation.context),
        "principal_id": annotation.principal_id,
        "created_at": annotation.created_at.isoformat().replace("+00:00", "Z"),
        "is_label": annotation.is_label,
    }


@annotations_router.post("", status_code=201)
async def record_annotation(body: AnnotationBody, caller: Authenticated) -> dict[str, Any]:
    """Records what a person decided about one trace.

    Re-annotating the same trace as the same person replaces the earlier
    verdict: that is somebody changing their mind, and counting both would
    inflate a failure mode by however often its reader hesitated.
    """
    annotation = await get_container().record_annotation.execute(
        RecordAnnotationCommand(
            caller=caller,
            trace_id=body.trace_id,
            verdict=body.verdict,
            failure_mode=body.failure_mode,
            note=body.note,
            evaluator=body.evaluator,
            question=body.question,
            answer=body.answer,
            context=tuple(body.context),
        )
    )
    return _annotation_response(annotation)


@annotations_router.get("")
async def list_annotations(
    caller: Authenticated,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 25,
    trace_id: Annotated[str | None, Query()] = None,
    failure_mode: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    page = await get_container().list_annotations.execute(
        caller, limit=limit, trace_id=trace_id, failure_mode=failure_mode
    )
    return {
        "items": [_annotation_response(annotation) for annotation in page.items],
        "taxonomy": [
            {"failure_mode": entry.failure_mode, "count": entry.count} for entry in page.taxonomy
        ],
        "next_cursor": None,
    }


@samples_router.get("")
async def list_samples(
    caller: Authenticated, limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 25
) -> dict[str, Any]:
    """What the sampled traffic scored.

    The summary is over the same page the caller asked for, unlike the
    annotation taxonomy: a mean is a statement about a set, and a mean over the
    last 25 calls beside a list of some other 25 would be unreadable.
    """
    samples = await get_container().samples.list(caller.project_id, limit=limit)
    summary = summarise(samples)

    return {
        "items": [
            {
                "id": sample.id,
                "project_id": sample.project_id,
                "request_id": sample.request_id,
                "alias": sample.alias,
                "scores": sample.scores,
                "unscorable": sample.unscorable,
                "judge_alias": sample.judge_alias,
                "sampled_at": sample.sampled_at.isoformat().replace("+00:00", "Z"),
            }
            for sample in samples
        ],
        "summary": {
            "evaluators": [
                {
                    "evaluator": entry.evaluator,
                    "mean": round(entry.mean, 4),
                    "sample_size": entry.sample_size,
                }
                for entry in summary.evaluators
            ],
            "scored": summary.scored,
            "unscorable": summary.unscorable,
        },
        "next_cursor": None,
    }


async def _ready() -> dict[str, str]:
    await get_container().ready()
    return {"status": "ok"}


health = health_router(ready=_ready)

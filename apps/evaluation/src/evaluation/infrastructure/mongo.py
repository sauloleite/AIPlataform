"""Run history in MongoDB.

The record is the point: a number nobody kept is an opinion again next week.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

from evaluation.domain.annotation import Annotation, AnnotationVerdict
from evaluation.domain.entities import (
    Answer,
    CaseResult,
    DatasetCase,
    EvaluationRun,
    Metric,
    RunStatus,
)


async def ensure_indexes(database: AsyncDatabase[Any]) -> None:
    await database["evaluation_runs"].create_index([("project_id", 1), ("started_at", -1)])
    await database["evaluation_runs"].create_index([("project_id", 1), ("suite", 1)])
    await database["annotations"].create_index([("project_id", 1), ("created_at", -1)])
    # Two annotations of the same trace by the same person are an edit, not a
    # second opinion: the taxonomy would otherwise count one reader's change of
    # mind twice. Two DIFFERENT people annotating the same trace is exactly what
    # inter-annotator disagreement looks like, and stays allowed.
    await database["annotations"].create_index(
        [("project_id", 1), ("trace_id", 1), ("principal_id", 1)], unique=True
    )


def mongo_client(uri: str) -> AsyncMongoClient[Any]:
    return AsyncMongoClient(uri, tz_aware=True)


@dataclass(slots=True)
class MongoRunRepository:
    database: AsyncDatabase[Any]

    async def save(self, run: EvaluationRun) -> None:
        await self.database["evaluation_runs"].update_one(
            {"_id": run.id}, {"$set": _from_run(run)}, upsert=True
        )

    async def find(self, project_id: str, run_id: str) -> EvaluationRun | None:
        document = await self.database["evaluation_runs"].find_one(
            {"_id": run_id, "project_id": project_id}
        )
        return _to_run(document) if document is not None else None

    async def list(self, project_id: str, *, limit: int) -> list[EvaluationRun]:
        cursor = (
            self.database["evaluation_runs"]
            .find({"project_id": project_id})
            .sort("started_at", -1)
            .limit(limit)
        )
        return [_to_run(document) async for document in cursor]


def _from_run(run: EvaluationRun) -> dict[str, Any]:
    return {
        "project_id": run.project_id,
        "suite": run.suite,
        "alias": run.alias,
        "principal_id": run.principal_id,
        # Which alias graded, and how well it agreed with the humans when the
        # run started. Both were computed and then thrown away: a stored run
        # could not say who graded it, let alone whether the grader was any
        # good, which is most of what makes an old score worth reading.
        "judge_alias": run.judge_alias,
        "judge_agreement": run.judge_agreement,
        "status": run.status.value,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "error_code": run.error_code,
        "metrics": [
            {
                "evaluator": metric.evaluator,
                "value": metric.value,
                "threshold": metric.threshold,
                "maximum": metric.maximum,
                "passed": metric.passed,
                "sample_size": metric.sample_size,
            }
            for metric in run.metrics
        ],
        # The per-case answers are kept: a score that dropped is only
        # actionable next to the answers that produced it. This is dataset
        # content, not user content -- the datasets forbid PII in the first
        # place, which is what makes keeping it safe.
        "results": [
            {
                "case_id": result.case.id,
                "input": result.case.input,
                "answer": None if result.answer is None else result.answer.text,
                "latency_ms": None if result.answer is None else result.answer.latency_ms,
                "cost_micros": None if result.answer is None else result.answer.cost_micros,
                "error_code": result.error_code,
                "scores": result.scores,
            }
            for result in run.results
        ],
    }


def _to_run(document: dict[str, Any]) -> EvaluationRun:
    run = EvaluationRun(
        id=str(document["_id"]),
        project_id=str(document.get("project_id", "")),
        suite=str(document.get("suite", "")),
        alias=str(document.get("alias", "")),
        principal_id=str(document.get("principal_id", "")),
        judge_alias=document.get("judge_alias"),
        judge_agreement={
            str(name): float(value)
            for name, value in (document.get("judge_agreement") or {}).items()
        },
        status=RunStatus(document.get("status", RunStatus.RUNNING.value)),
        started_at=_aware(document.get("started_at")),
        finished_at=document.get("finished_at"),
        error_code=document.get("error_code"),
    )
    run.metrics = [
        Metric(
            evaluator=str(raw.get("evaluator", "")),
            value=float(raw.get("value", 0.0)),
            threshold=raw.get("threshold"),
            maximum=raw.get("maximum"),
            passed=bool(raw.get("passed")),
            sample_size=int(raw.get("sample_size", 0)),
        )
        for raw in document.get("metrics") or []
    ]
    run.results = [
        CaseResult(
            case=DatasetCase(id=str(raw.get("case_id", "")), input=str(raw.get("input", ""))),
            answer=(
                None
                if raw.get("answer") is None
                else Answer(
                    text=str(raw.get("answer")),
                    latency_ms=int(raw.get("latency_ms") or 0),
                    cost_micros=int(raw.get("cost_micros") or 0),
                )
            ),
            error_code=raw.get("error_code"),
            scores=dict(raw.get("scores") or {}),
        )
        for raw in document.get("results") or []
    ]
    return run


def _aware(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return datetime.now(UTC)


@dataclass(slots=True)
class MongoAnnotationRepository:
    """What people decided about real traces.

    Holds a principal id and, when the project captures content, real user text
    -- which is why it is in the LGPD inventory (`docs/runbooks/`) rather than
    quietly accumulating beside the run history.
    """

    database: AsyncDatabase[Any]

    async def save(self, annotation: Annotation) -> None:
        # Upsert on (project, trace, principal): re-annotating is a person
        # changing their mind, and keeping both would count it twice.
        await self.database["annotations"].update_one(
            {
                "project_id": annotation.project_id,
                "trace_id": annotation.trace_id,
                "principal_id": annotation.principal_id,
            },
            {"$set": _from_annotation(annotation)},
            upsert=True,
        )

    async def list(
        self,
        project_id: str,
        *,
        limit: int,
        trace_id: str | None = None,
        failure_mode: str | None = None,
    ) -> list[Annotation]:
        query: dict[str, Any] = {"project_id": project_id}
        if trace_id is not None:
            query["trace_id"] = trace_id
        if failure_mode is not None:
            query["failure_mode"] = failure_mode

        cursor = self.database["annotations"].find(query).sort("created_at", -1).limit(limit)
        return [_to_annotation(document) async for document in cursor]


def _from_annotation(annotation: Annotation) -> dict[str, Any]:
    return {
        "_id": annotation.id,
        "project_id": annotation.project_id,
        "trace_id": annotation.trace_id,
        "verdict": annotation.verdict.value,
        "principal_id": annotation.principal_id,
        "failure_mode": annotation.failure_mode,
        "note": annotation.note,
        "evaluator": annotation.evaluator,
        "question": annotation.question,
        "answer": annotation.answer,
        "context": list(annotation.context),
        "created_at": annotation.created_at,
    }


def _to_annotation(document: dict[str, Any]) -> Annotation:
    return Annotation(
        id=str(document["_id"]),
        project_id=str(document.get("project_id", "")),
        trace_id=str(document.get("trace_id", "")),
        verdict=AnnotationVerdict(document.get("verdict", AnnotationVerdict.BAD.value)),
        principal_id=str(document.get("principal_id", "")),
        failure_mode=document.get("failure_mode"),
        note=str(document.get("note") or ""),
        evaluator=document.get("evaluator"),
        question=str(document.get("question") or ""),
        answer=str(document.get("answer") or ""),
        context=tuple(str(item) for item in document.get("context") or []),
        created_at=_aware(document.get("created_at")),
    )

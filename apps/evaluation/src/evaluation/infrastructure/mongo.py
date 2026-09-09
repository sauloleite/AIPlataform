"""Run history in MongoDB.

The record is the point: a number nobody kept is an opinion again next week.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

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

"""MongoDB adapters for runs and checkpoints.

A checkpoint is the reason a run survives a restart: reference doc 02 requires
durable execution, and an in-memory dict loses every run the moment a pod is
rescheduled. `motor` is not used — `pymongo` ships an async client since 4.9,
and it is the driver `aia_messaging` already depends on.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pymongo import AsyncMongoClient, ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

from agent_runtime.domain.entities import Run, RunState, RunStatus, ToolCall


async def ensure_indexes(database: AsyncDatabase[Any]) -> None:
    """Created at boot, the way the Node services do it.

    `thread_id` is indexed because reading a conversation back is the console's
    normal read; without it that is a collection scan the day a project has
    thousands of runs.
    """
    await database["runs"].create_index([("project_id", 1), ("created_at", -1)])
    await database["runs"].create_index([("project_id", 1), ("thread_id", 1)])
    await database["checkpoints"].create_index("run_id", unique=True)


@dataclass(slots=True)
class MongoRunRepository:
    database: AsyncDatabase[Any]

    async def find(self, run_id: str) -> Run | None:
        document = await self.database["runs"].find_one({"_id": run_id})
        return _to_run(document) if document is not None else None

    async def save(self, run: Run) -> None:
        await self.database["runs"].find_one_and_update(
            {"_id": run.id},
            {"$set": _from_run(run)},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )


@dataclass(slots=True)
class MongoCheckpointer:
    database: AsyncDatabase[Any]

    async def save(self, state: RunState) -> None:
        await self.database["checkpoints"].update_one(
            {"run_id": state.run_id},
            {"$set": {**_from_state(state), "saved_at": datetime.now(UTC)}},
            upsert=True,
        )

    async def load(self, run_id: str) -> RunState | None:
        document = await self.database["checkpoints"].find_one({"run_id": run_id})
        return _to_state(document) if document is not None else None


def mongo_client(uri: str) -> AsyncMongoClient[Any]:
    return AsyncMongoClient(uri, tz_aware=True)


# --------------------------------------------------------------------------
# Serialisation. Explicit both ways: reading a document straight into a
# dataclass would let a field renamed in code silently read as its default.


def _from_run(run: Run) -> dict[str, Any]:
    return {
        "agent_id": run.agent_id,
        "agent_version": run.agent_version,
        "thread_id": run.thread_id,
        "project_id": run.project_id,
        "principal_id": run.principal_id,
        "status": run.status.value,
        "created_at": run.created_at,
        "finished_at": run.finished_at,
        "error_code": run.error_code,
        "output": run.output,
    }


def _to_run(document: dict[str, Any]) -> Run:
    return Run(
        id=str(document["_id"]),
        agent_id=str(document.get("agent_id", "")),
        agent_version=int(document.get("agent_version", 0)),
        thread_id=str(document.get("thread_id", "")),
        project_id=str(document.get("project_id", "")),
        principal_id=str(document.get("principal_id", "")),
        status=RunStatus(document.get("status", RunStatus.PENDING.value)),
        created_at=_aware(document.get("created_at")),
        finished_at=document.get("finished_at"),
        error_code=document.get("error_code"),
        output=document.get("output"),
    )


def _from_state(state: RunState) -> dict[str, Any]:
    return {
        "run_id": state.run_id,
        "project_id": state.project_id,
        "agent_id": state.agent_id,
        "agent_version": state.agent_version,
        "thread_id": state.thread_id,
        "step": state.step,
        "tool_calls_made": state.tool_calls_made,
        "messages": state.messages,
        "definition": state.definition,
        "pending_call": _from_call(state.pending_call),
        "queued_calls": [_from_call(call) for call in state.queued_calls],
    }


def _to_state(document: dict[str, Any]) -> RunState:
    return RunState(
        run_id=str(document["run_id"]),
        project_id=str(document.get("project_id", "")),
        agent_id=str(document.get("agent_id", "")),
        agent_version=int(document.get("agent_version", 0)),
        thread_id=str(document.get("thread_id", "")),
        step=int(document.get("step", 0)),
        tool_calls_made=int(document.get("tool_calls_made", 0)),
        messages=list(document.get("messages") or []),
        definition=dict(document.get("definition") or {}),
        pending_call=_to_call(document.get("pending_call")),
        queued_calls=[
            call for call in map(_to_call, document.get("queued_calls") or []) if call is not None
        ],
    )


def _from_call(call: ToolCall | None) -> dict[str, Any] | None:
    if call is None:
        return None
    return {
        "id": call.id,
        "tool_name": call.tool_name,
        "arguments": call.arguments,
        "risk_level": call.risk_level,
        "tool_id": call.tool_id,
        "requires_approval": call.requires_approval,
        "blocked_reason": call.blocked_reason,
        "provider_state": call.provider_state,
    }


def _to_call(raw: Any) -> ToolCall | None:
    if not isinstance(raw, dict):
        return None
    return ToolCall(
        id=str(raw.get("id", "")),
        tool_name=str(raw.get("tool_name", "")),
        arguments=dict(raw.get("arguments") or {}),
        risk_level=str(raw.get("risk_level", "low")),
        tool_id=raw.get("tool_id"),
        requires_approval=bool(raw.get("requires_approval", False)),
        blocked_reason=raw.get("blocked_reason"),
        provider_state=raw.get("provider_state"),
    )


def _aware(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return datetime.now(UTC)

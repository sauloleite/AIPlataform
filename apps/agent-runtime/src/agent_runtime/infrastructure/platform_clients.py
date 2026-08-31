"""HTTP clients for the services a run depends on.

All three carry the CALLER's token, never a service credential. A service
principal is a member of no project, so the registry and the gateway would
refuse it — and if they did not, the agent would be able to reach data the
person who started the run cannot (ADR-017).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from agent_runtime.domain.definitions import AgentDefinition, AvailableTool, ResolvedAgent
from agent_runtime.domain.entities import ToolCall
from agent_runtime.domain.errors import AgentNotPublishedError
from aia_errors import DomainError, ErrorCode
from aia_resilience import Policies, ResilienceExecutor


def _headers(access_token: str, project_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "X-Project-Id": project_id,
        "Content-Type": "application/json",
    }


def _raise_problem(response: httpx.Response, fallback: str) -> None:
    """Turns an upstream Problem Details back into a typed error.

    Without this the caller sees a bare 502 where the platform already said
    exactly what was wrong — `tool_not_allowed`, `budget_exhausted` — and that
    detail is what the model needs to read on the next turn.
    """
    code = ErrorCode.INTERNAL_ERROR
    detail = fallback
    try:
        problem = response.json()
    except ValueError:
        problem = None
    if isinstance(problem, dict):
        code = str(problem.get("code") or code)
        detail = str(problem.get("detail") or problem.get("title") or fallback)

    raise DomainError(detail, code=code, status=response.status_code)


@dataclass(slots=True)
class HttpAgentSource:
    """aia-registry. Resolves the PUBLISHED version a run pins itself to."""

    base_url: str
    timeout_seconds: float = 10.0
    # One executor for the life of the adapter, not one per call. A circuit
    # breaker is state: rebuilt on every request it forgets every failure, and
    # a dead dependency gets hammered instead of shed.
    executor: ResilienceExecutor = field(
        default_factory=lambda: ResilienceExecutor(Policies.INTERNAL)
    )

    async def resolve(self, *, agent_id: str, project_id: str, access_token: str) -> ResolvedAgent:
        async def call() -> ResolvedAgent:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.get(
                    f"{self.base_url}/v1/assets/{agent_id}/published",
                    headers=_headers(access_token, project_id),
                )
            if response.status_code == 404:
                raise AgentNotPublishedError(agent_id)
            if response.status_code >= 400:
                _raise_problem(response, "The registry refused to resolve the agent")

            payload: dict[str, Any] = response.json()
            raw = payload.get("definition") or {}
            return ResolvedAgent(
                agent_id=agent_id,
                version=int(payload.get("version") or 0),
                definition=AgentDefinition.from_definition(raw),
                raw=raw,
            )

        return await self.executor.execute(call, key=f"registry:{project_id}")


@dataclass(slots=True)
class HttpToolCatalog:
    """aia-mcp-gateway's effective tools: the allow-list, as this caller sees it."""

    base_url: str
    timeout_seconds: float = 10.0
    executor: ResilienceExecutor = field(
        default_factory=lambda: ResilienceExecutor(Policies.INTERNAL)
    )

    async def effective(self, *, project_id: str, access_token: str) -> list[AvailableTool]:
        async def call() -> list[AvailableTool]:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.get(
                    f"{self.base_url}/v1/tools", headers=_headers(access_token, project_id)
                )
            if response.status_code >= 400:
                _raise_problem(response, "The tool gateway refused to list the tools")

            items = response.json().get("items") or []
            return [
                AvailableTool(
                    tool_id=str(item["tool_id"]),
                    slug=str(item["slug"]),
                    name=str(item.get("name") or item["slug"]),
                    description=str(item.get("description") or ""),
                    risk_level=str(item.get("risk_level") or "low"),
                    requires_approval=bool(item.get("requires_approval")),
                    parameters=dict(item.get("parameters") or {}),
                    builtin_id=(
                        str(item["builtin_id"]) if item.get("builtin_id") is not None else None
                    ),
                )
                for item in items
                if item.get("tool_id") and item.get("slug")
            ]

        return await self.executor.execute(call, key=f"gateway-tools:{project_id}")


@dataclass(slots=True)
class HttpToolGateway:
    """aia-mcp-gateway invocation.

    No retry, deliberately: `Policies.TOOL` has none, because a tool action may
    not be idempotent and repeating it would turn one click into three
    (reference doc 02 §8).

    The gateway has its own approval control, and it fires on the same tools the
    runtime holds. Left alone the two deadlock: the runtime asks a person, the
    person says yes, and the gateway then asks a person nobody is there to be.
    So an approval obtained HERE is carried through the gateway's handshake --
    see `invoke`.
    """

    base_url: str
    timeout_seconds: float = 30.0
    executor: ResilienceExecutor = field(default_factory=lambda: ResilienceExecutor(Policies.TOOL))

    async def invoke(
        self,
        *,
        call: ToolCall,
        principal_id: str,
        project_id: str,
        access_token: str,
        human_approved: bool = False,
    ) -> dict[str, Any]:
        """Runs a tool as the caller.

        `human_approved` says a person saw THESE arguments and said yes. It is
        what lets the gateway's 202 be answered instead of surfaced: the
        gateway binds its approval to a hash of the arguments, and the second
        call sends the same dict, so the thing that runs is the thing that was
        shown. Without an approval a 202 is reported as the refusal it is --
        nobody looked at that call, and the runtime must not vouch for it.
        """
        _ = principal_id  # the token already says who this is; the gateway reads it

        async def invocation() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await self._post(client, call, project_id, access_token)

                if response.status_code == 202:
                    if not human_approved:
                        # The binding raised the bar after the tool list was
                        # read. Not something to wave through.
                        _raise_problem(response, "The gateway requires an approval")

                    # Not a retry: a 202 means the tool did NOT run. This is the
                    # second half of one handshake, with the same arguments.
                    approval_id = str(response.json().get("approval_id") or "")
                    response = await self._post(
                        client, call, project_id, access_token, approval_id=approval_id
                    )

            if response.status_code == 202:
                # It asked twice. Something is wrong with the approval, and
                # reporting success would be a lie.
                _raise_problem(response, "The gateway would not accept the approval")
            if response.status_code >= 400:
                _raise_problem(response, "The tool failed to run")

            payload: dict[str, Any] = response.json()
            return {
                "status": payload.get("status", "ok"),
                "result": payload.get("result"),
                "duration_ms": payload.get("duration_ms"),
            }

        return await self.executor.execute(invocation, key=f"tool:{call.tool_id}")

    async def _post(
        self,
        client: httpx.AsyncClient,
        call: ToolCall,
        project_id: str,
        access_token: str,
        approval_id: str | None = None,
    ) -> httpx.Response:
        body: dict[str, Any] = {"arguments": call.arguments}
        if approval_id:
            body["approval_id"] = approval_id

        return await client.post(
            f"{self.base_url}/v1/tools/{call.tool_id}/invoke",
            headers=_headers(access_token, project_id),
            json=body,
        )

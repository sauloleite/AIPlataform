"""The platform, over HTTP."""

from __future__ import annotations

import inspect
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from aia_resilience import Policies, ResilienceExecutor
from aia_sdk._errors import PlatformError, error_from
from aia_sdk._types import (
    ChatEvent,
    Completion,
    Delta,
    Finished,
    Message,
    ModelAlias,
    Routing,
    Run,
    SearchHit,
    StreamError,
    TokenSource,
    ToolCall,
    Usage,
)


def _completion_of(payload: dict[str, Any]) -> Completion:
    choice = (payload.get("choices") or [{}])[0]
    usage = payload.get("usage") or {}
    aia = payload.get("aia") or {}
    cost = aia.get("cost") or {}
    return Completion(
        id=str(payload.get("id") or ""),
        model=str(payload.get("model") or ""),
        content=str((choice.get("message") or {}).get("content") or ""),
        finish_reason=choice.get("finish_reason"),
        usage=Usage(
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            total_tokens=int(usage.get("total_tokens") or 0),
        ),
        routing=Routing(
            deployment_id=str(aia.get("deployment_id") or ""),
            provider=str(aia.get("provider") or ""),
            data_zone=str(aia.get("data_zone") or ""),
            cost_micros=int(cost.get("micros") or 0),
            currency=str(cost.get("currency") or "BRL"),
            budget_unverified=bool(aia.get("budget_unverified")),
            policy_stale=bool(aia.get("policy_stale")),
            guardrails_unverified=bool(aia.get("guardrails_unverified")),
        ),
        raw=payload,
    )


def _run_of(payload: dict[str, Any]) -> Run:
    pending = payload.get("pending_call")
    return Run(
        id=str(payload.get("id") or ""),
        agent_id=str(payload.get("agent_id") or ""),
        status=str(payload.get("status") or ""),
        step=int(payload.get("step") or 0),
        output=payload.get("output"),
        pending_call=(
            ToolCall(
                id=str(pending.get("id") or ""),
                tool_name=str(pending.get("tool_name") or ""),
                arguments=pending.get("arguments") or {},
                risk_level=str(pending.get("risk_level") or ""),
            )
            if isinstance(pending, dict)
            else None
        ),
        raw=payload,
    )


@dataclass(slots=True)
class AiaClient:
    """The platform's canonical API, with the platform's own policies applied.

    Three things this does that a hand-written `httpx` call in each consumer
    would not: it applies the resilience policies the services themselves use
    rather than a guess at a timeout, it turns Problem Details into an exception
    carrying the stable code and the trace id, and it puts the tenant on every
    request. The third matters most -- `X-Project-Id` forgotten on one call out
    of forty is a 400 in production and nowhere else.
    """

    base_url: str
    project_id: str
    token: TokenSource
    #: Injected so a test can answer without a socket.
    client: httpx.AsyncClient | None = None

    # The policies are the platform's, not this client's. A consumer inventing
    # its own timeout would either give up before the router's own ceiling --
    # turning a slow answer into a failed one -- or wait long past it.
    _inference: ResilienceExecutor = field(init=False)
    _embeddings: ResilienceExecutor = field(init=False)
    _platform: ResilienceExecutor = field(init=False)
    _owned: httpx.AsyncClient | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        self._inference = ResilienceExecutor(Policies.INFERENCE)
        self._embeddings = ResilienceExecutor(Policies.EMBEDDINGS)
        self._platform = ResilienceExecutor(Policies.INTERNAL)

    async def __aenter__(self) -> AiaClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owned is not None:
            await self._owned.aclose()
            self._owned = None

    # ------------------------------------------------------------------ chat

    async def chat(
        self, *, model: str, messages: Sequence[Message], max_tokens: int | None = None
    ) -> Completion:
        payload = await self._json(
            "POST",
            "/v1/chat/completions",
            self._inference,
            "chat",
            body=self._chat_body(model, messages, max_tokens, stream=False),
        )
        return _completion_of(payload)

    async def chat_stream(
        self, *, model: str, messages: Sequence[Message], max_tokens: int | None = None
    ) -> AsyncIterator[ChatEvent]:
        """The stream, event by event.

        No `ResilienceExecutor` here, and that is the policy rather than an
        omission: a retry is allowed only before the first token, and once bytes
        have reached the caller there is nothing to retry into -- replaying would
        repeat text the caller already has. A failure after the first token
        arrives as a `StreamError`, which is how the router sends it.
        """
        headers = await self._headers(json_body=True)
        headers["Accept"] = "text/event-stream"
        body = self._chat_body(model, messages, max_tokens, stream=True)

        client = self._http()
        async with client.stream(
            "POST", f"{self.base_url}/v1/chat/completions", headers=headers, json=body
        ) as response:
            if response.status_code >= httpx.codes.BAD_REQUEST:
                await response.aread()
                raise error_from(response, "/v1/chat/completions")

            async for event, data in _sse(response):
                if event == "message.delta":
                    content = str((data.get("delta") or {}).get("content") or "")
                    if content:
                        yield Delta(content=content)
                elif event == "run.finished":
                    yield Finished(completion=_completion_of(data))
                elif event == "error":
                    yield StreamError(
                        code=str(data.get("code") or "internal_error"),
                        message=str(data.get("message") or "The stream failed"),
                    )

    # ------------------------------------------------------- everything else

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        payload = await self._json(
            "POST",
            "/v1/embeddings",
            self._embeddings,
            "embeddings",
            body={"model": model, "input": list(texts)},
        )
        return [list(item["embedding"]) for item in payload.get("data") or []]

    async def models(self) -> list[ModelAlias]:
        payload = await self._json("GET", "/v1/models", self._platform, "models")
        return [
            ModelAlias(
                id=str(item.get("id") or ""),
                description=str(item.get("description") or ""),
                capabilities=tuple(item.get("capabilities") or ()),
                data_zones=tuple(item.get("data_zones") or ()),
            )
            for item in payload.get("data") or []
        ]

    async def search(
        self, store_id: str, query: str, *, top_k: int | None = None, mode: str | None = None
    ) -> list[SearchHit]:
        body: dict[str, Any] = {"query": query}
        if top_k is not None:
            body["top_k"] = top_k
        if mode is not None:
            body["mode"] = mode
        payload = await self._json(
            "POST", f"/v1/stores/{store_id}/search", self._platform, "search", body=body
        )
        return [
            SearchHit(
                document_id=str(hit.get("document_id") or ""),
                document_title=str(hit.get("document_title") or ""),
                chunk_index=int(hit.get("chunk_index") or 0),
                score=float(hit.get("score") or 0.0),
                retrieval=str(hit.get("retrieval") or ""),
                text=str(hit.get("text") or ""),
            )
            for hit in payload.get("results") or []
        ]

    async def start_run(self, agent_id: str, prompt: str, *, thread_id: str | None = None) -> Run:
        body: dict[str, Any] = {"input": prompt}
        if thread_id is not None:
            body["thread_id"] = thread_id
        # A run holds a model call, so it gets the inference policy and not the
        # two-second one meant for reading a policy document.
        payload = await self._json(
            "POST", f"/v1/agents/{agent_id}/runs", self._inference, "runs", body=body
        )
        return _run_of(payload)

    async def get_run(self, run_id: str) -> Run:
        return _run_of(await self._json("GET", f"/v1/runs/{run_id}", self._platform, "run"))

    async def approve(self, run_id: str, tool_call_id: str, *, approved: bool = True) -> Run:
        payload = await self._json(
            "POST",
            f"/v1/runs/{run_id}/approve",
            self._inference,
            "approve",
            body={"tool_call_id": tool_call_id, "approved": approved},
        )
        return _run_of(payload)

    # ---------------------------------------------------------------- plumbing

    def _http(self) -> httpx.AsyncClient:
        if self.client is not None:
            return self.client
        if self._owned is None:
            self._owned = httpx.AsyncClient()
        return self._owned

    @staticmethod
    def _chat_body(
        model: str, messages: Sequence[Message], max_tokens: int | None, *, stream: bool
    ) -> dict[str, Any]:
        return {
            "model": model,
            "messages": [message.as_payload() for message in messages],
            "stream": stream,
            **({"max_tokens": max_tokens} if max_tokens is not None else {}),
        }

    async def _headers(self, *, json_body: bool) -> dict[str, str]:
        token = self.token
        if not isinstance(token, str):
            resolved = token()
            token = await resolved if inspect.isawaitable(resolved) else resolved
        return {
            "Authorization": f"Bearer {token}",
            "X-Project-Id": self.project_id,
            **({"Content-Type": "application/json"} if json_body else {}),
        }

    async def _json(
        self,
        method: str,
        path: str,
        executor: ResilienceExecutor,
        route: str,
        *,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        async def call() -> dict[str, Any]:
            headers = await self._headers(json_body=body is not None)
            response = await self._http().request(
                method, f"{self.base_url}{path}", headers=headers, json=body
            )
            if response.status_code >= httpx.codes.BAD_REQUEST:
                raise error_from(response, path)
            payload: dict[str, Any] = response.json()
            return payload

        # Keyed by ROUTE, not by path: `/v1/runs/{id}` is one dependency, and a
        # key carrying the id would open a fresh circuit for every run -- a
        # breaker that has never seen a second call cannot break.
        return await executor.execute(call, key=route)


async def _sse(response: httpx.Response) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Server-Sent Events, parsed.

    Frames are separated by a blank line and a frame can be split across network
    chunks, so the buffer is what makes this correct: reading each chunk as a
    whole frame works on a fast local connection and truncates a JSON payload
    the first time a real network splits one.
    """
    buffer = ""
    async for chunk in response.aiter_text():
        buffer += chunk
        while "\n\n" in buffer:
            raw, buffer = buffer.split("\n\n", 1)
            frame = _parse_frame(raw)
            if frame is not None:
                yield frame


def _parse_frame(raw: str) -> tuple[str, dict[str, Any]] | None:
    event = "message"
    data: list[str] = []
    for line in raw.split("\n"):
        if line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data.append(line[len("data:") :].strip())

    try:
        payload = json.loads("\n".join(data))
    except ValueError:
        # Everything that carries nothing usable leaves here: a heartbeat
        # (`: ping` is a comment with no `data:` line, and an empty string does
        # not parse) and a truncated payload alike.
        return None
    return (event, payload) if isinstance(payload, dict) else None


__all__ = ["AiaClient", "PlatformError"]

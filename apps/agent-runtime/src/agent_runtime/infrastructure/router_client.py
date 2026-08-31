"""Client for aia-inference-router.

An agent NEVER talks to a model provider directly (reference doc 02, principle
1): without that, budget, classification-based routing and audit would stop
applying to everything an agent does.

It streams even when the caller does not, because the loop has one path through
a model call and a second one would drift.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from aia_errors import DomainError, ErrorCode


@dataclass(slots=True)
class HttpModelClient:
    """The router client.

    `read_timeout_seconds` is the gap between two chunks, not the length of the
    answer: a stream that keeps arriving never trips it. It is generous because
    a local model on a cold start can take minutes to produce its first token,
    and a run that dies there looks like a platform fault rather than a slow
    machine.
    """

    base_url: str
    connect_timeout_seconds: float = 5.0
    read_timeout_seconds: float = 180.0

    async def stream(
        self,
        *,
        alias: str,
        messages: list[dict[str, Any]],
        project_id: str,
        access_token: str,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        body: dict[str, Any] = {"model": alias, "messages": messages, "stream": True}
        if tools:
            body["tools"] = tools
        if temperature is not None:
            body["temperature"] = temperature
        if top_p is not None:
            body["top_p"] = top_p
        if max_tokens is not None:
            body["max_completion_tokens"] = max_tokens

        headers = {
            "Authorization": f"Bearer {access_token}",
            "X-Project-Id": project_id,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }

        timeout = httpx.Timeout(self.read_timeout_seconds, connect=self.connect_timeout_seconds)

        async with (
            httpx.AsyncClient(timeout=timeout) as client,
            client.stream(
                "POST", f"{self.base_url}/v1/chat/completions", headers=headers, json=body
            ) as response,
        ):
            if response.status_code >= 400:
                await response.aread()
                _raise_problem(response)

            try:
                async for chunk in _read_events(response):
                    yield chunk
            except httpx.TimeoutException as error:
                # A typed error, not a bare exception: reaching the client as
                # "Internal error" would hide a condition an operator can act on.
                raise DomainError(
                    "The model stopped answering",
                    code=ErrorCode.UPSTREAM_TIMEOUT,
                    status=504,
                ) from error
            except httpx.HTTPError as error:
                raise DomainError(
                    "The connection to the inference router failed",
                    code=ErrorCode.PROVIDER_UNAVAILABLE,
                    status=502,
                ) from error


async def _read_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    """Reads the router's named SSE events.

    The router sends `event:` and `data:` on separate lines, so the event name
    has to be remembered until its data arrives — reading `data:` alone would
    make a delta indistinguishable from the final completion.
    """
    event_name = "message"

    async for raw in response.aiter_lines():
        line = raw.rstrip("\r")
        if line == "" or line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
            continue
        if not line.startswith("data:"):
            continue

        payload = _parse(line[len("data:") :].strip())
        if payload is None:
            continue

        if event_name == "message.delta":
            content = ((payload.get("delta") or {}).get("content")) or ""
            if content:
                yield {"kind": "delta", "content": content}
        elif event_name == "run.finished":
            yield _finished(payload)
        elif event_name == "error":
            raise DomainError(
                str(payload.get("message") or "The model stream failed"),
                code=str(payload.get("code") or ErrorCode.INTERNAL_ERROR),
                status=502,
            )


def _finished(payload: dict[str, Any]) -> dict[str, Any]:
    message = ((payload.get("choices") or [{}])[0]).get("message") or {}
    return {
        "kind": "finished",
        "content": message.get("content") or "",
        "tool_calls": message.get("tool_calls") or [],
        "finish_reason": ((payload.get("choices") or [{}])[0]).get("finish_reason"),
        "usage": payload.get("usage") or {},
        "aia": payload.get("aia") or {},
    }


def _parse(data: str) -> dict[str, Any] | None:
    if data == "" or data == "[DONE]":
        return None
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _raise_problem(response: httpx.Response) -> None:
    code = ErrorCode.INTERNAL_ERROR
    detail = "The inference router refused the call"
    try:
        problem = response.json()
    except ValueError:
        problem = None
    if isinstance(problem, dict):
        code = str(problem.get("code") or code)
        detail = str(problem.get("detail") or problem.get("title") or detail)

    raise DomainError(detail, code=code, status=response.status_code)

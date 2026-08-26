"""Client for aia-inference-router.

An agent NEVER talks to a model provider directly (reference doc 02, principle
1): without that, budget, classification-based routing and audit would stop
applying to everything an agent does.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from aia_resilience import Policies, ResilienceExecutor


@dataclass(slots=True)
class HttpModelClient:
    base_url: str
    service_token: str
    timeout_seconds: float = 60.0

    def _headers(self, project_id: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.service_token}",
            "X-Project-Id": project_id,
            "Content-Type": "application/json",
        }

    async def chat(
        self, *, alias: str, messages: list[dict[str, Any]], project_id: str
    ) -> dict[str, Any]:
        executor = ResilienceExecutor(Policies.INFERENCE)

        async def call() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}/v1/chat/completions",
                    headers=self._headers(project_id),
                    json={"model": alias, "messages": messages},
                )
                response.raise_for_status()
                payload: dict[str, Any] = response.json()
                choice = (payload.get("choices") or [{}])[0]
                return {
                    "content": (choice.get("message") or {}).get("content", ""),
                    "usage": payload.get("usage", {}),
                    "aia": payload.get("aia", {}),
                }

        return await executor.execute(call, key=f"router:{alias}")

    async def stream(
        self, *, alias: str, messages: list[dict[str, Any]], project_id: str
    ) -> AsyncIterator[str]:
        async with (
            httpx.AsyncClient(timeout=self.timeout_seconds) as client,
            client.stream(
                "POST",
                f"{self.base_url}/v1/chat/completions",
                headers={**self._headers(project_id), "Accept": "text/event-stream"},
                json={"model": alias, "messages": messages, "stream": True},
            ) as response,
        ):
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    yield line[5:].strip()

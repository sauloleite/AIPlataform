"""Dependency composition. Never inside a use case."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from agent_runtime.application.use_cases.approve_tool_call import ApproveToolCall
from agent_runtime.application.use_cases.start_run import StartRun
from agent_runtime.config import Settings, get_settings
from agent_runtime.infrastructure.in_memory import (
    InMemoryCheckpointer,
    InMemoryRunRepository,
    RecordingToolGateway,
)
from agent_runtime.infrastructure.router_client import HttpModelClient
from aia_auth import JwtVerifier


@dataclass(slots=True)
class Container:
    settings: Settings
    start_run: StartRun
    approve_tool_call: ApproveToolCall
    verifier: JwtVerifier
    runs: InMemoryRunRepository


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    runs = InMemoryRunRepository()
    checkpointer = InMemoryCheckpointer()
    tools = RecordingToolGateway()

    model = HttpModelClient(
        base_url=settings.inference_router_url,
        service_token=settings.agent_runtime_service_token,
    )

    return Container(
        settings=settings,
        runs=runs,
        start_run=StartRun(
            runs=runs,
            checkpointer=checkpointer,
            model=model,
            default_alias=settings.default_alias,
        ),
        approve_tool_call=ApproveToolCall(checkpointer=checkpointer, tools=tools),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )

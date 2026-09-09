"""What the platform offers a client, as one Protocol.

Mirrors `packages/sdk/src/types.ts`. Two things implement it: `AiaClient`, which
speaks HTTP, and `FakeAia`, which answers from memory. That is not a
convenience -- it is the design test. If a capability cannot be expressed here
without leaking a URL, a header or a status code, the API is asking the caller
to know too much.

The dataclasses below are hand-written rather than generated, and the reason is
worth stating: the Python contracts package generates the ONE thing two
languages must agree on byte for byte (ADR-027's data-zone table) and nothing
else. A Pydantic model tree generated from ten OpenAPI documents would be a
second source of truth for every request shape, drifting against the
TypeScript one with nothing comparing them. What the client sends is validated
by the platform, which is the only place that can validate it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str | None = None
    name: str | None = None
    tool_call_id: str | None = None

    def as_payload(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": self.content,
            **({"name": self.name} if self.name is not None else {}),
            **({"tool_call_id": self.tool_call_id} if self.tool_call_id is not None else {}),
        }


@dataclass(frozen=True, slots=True)
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass(frozen=True, slots=True)
class Routing:
    """`aia` on a completion: which deployment served it, in which zone, at what cost.

    `budget_unverified` and `policy_stale` are not decoration. They are how the
    platform says it answered while a dependency was down, and a caller that
    ignores them is billing against numbers nobody checked.
    """

    deployment_id: str = ""
    provider: str = ""
    data_zone: str = ""
    cost_micros: int = 0
    currency: str = "BRL"
    budget_unverified: bool = False
    policy_stale: bool = False
    guardrails_unverified: bool = False


@dataclass(frozen=True, slots=True)
class Completion:
    id: str
    model: str
    content: str
    finish_reason: str | None
    usage: Usage
    routing: Routing
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Delta:
    """One piece of a streamed answer."""

    content: str


@dataclass(frozen=True, slots=True)
class Finished:
    completion: Completion


@dataclass(frozen=True, slots=True)
class StreamError:
    """A failure that arrived after the headers, where a status is no longer possible."""

    code: str
    message: str


ChatEvent = Delta | Finished | StreamError


@dataclass(frozen=True, slots=True)
class ModelAlias:
    id: str
    description: str = ""
    capabilities: tuple[str, ...] = ()
    data_zones: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SearchHit:
    document_id: str
    document_title: str
    chunk_index: int
    score: float
    retrieval: str
    text: str


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    tool_name: str
    arguments: Mapping[str, Any]
    risk_level: str


@dataclass(frozen=True, slots=True)
class Run:
    id: str
    agent_id: str
    status: str
    step: int
    output: str | None = None
    pending_call: ToolCall | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def waiting_approval(self) -> bool:
        return self.status == "waiting_approval"


@runtime_checkable
class Aia(Protocol):
    """Everything a consumer of this platform does."""

    async def chat(
        self, *, model: str, messages: Sequence[Message], max_tokens: int | None = None
    ) -> Completion: ...

    def chat_stream(
        self, *, model: str, messages: Sequence[Message], max_tokens: int | None = None
    ) -> AsyncIterator[ChatEvent]: ...

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]: ...

    async def models(self) -> list[ModelAlias]: ...

    async def search(
        self, store_id: str, query: str, *, top_k: int | None = None, mode: str | None = None
    ) -> list[SearchHit]: ...

    async def start_run(
        self, agent_id: str, prompt: str, *, thread_id: str | None = None
    ) -> Run: ...

    async def get_run(self, run_id: str) -> Run: ...

    async def approve(self, run_id: str, tool_call_id: str, *, approved: bool = True) -> Run: ...


#: A token, or a way to get one. The callable form exists because a personal
#: access token in a constant is a credential with no expiry: a service using
#: client credentials refreshes, and the SDK has to ask again rather than cache
#: what it was handed once.
TokenSource = str | Callable[[], str | Awaitable[str]]

"""The platform, in memory."""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from aia_errors import ErrorCode
from aia_sdk._errors import PlatformError
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
    ToolCall,
    Usage,
)


@dataclass(frozen=True, slots=True)
class Document:
    document_id: str
    title: str
    text: str


@dataclass(slots=True)
class FakeAia:
    """The platform, answering from memory.

    This exists to answer one question about the design: can somebody test code
    that uses this platform without a credential, a container or a network? If
    the answer needs a running service, the SDK has leaked its transport into
    its interface and the interface is wrong.

    It is not a mock. Nothing here records calls or asserts an order; it answers
    the way the platform answers, refusals included, because those are the paths
    a caller most needs to be able to reproduce -- and reproducing an exhausted
    budget against a real platform means exhausting a real budget.
    """

    reply: str = "ok"
    #: Vector width. Three, because a test asserting on 1536 numbers asserts nothing.
    dimensions: int = 3
    documents: tuple[Document, ...] = ()
    model_list: tuple[ModelAlias, ...] = (
        ModelAlias(
            id="chat-local",
            description="Local model only. No data leaves the machine.",
            capabilities=("chat",),
            data_zones=("local",),
        ),
    )
    _runs: dict[str, Run] = field(default_factory=dict, init=False)
    _next_failure: PlatformError | None = field(default=None, init=False)
    _counter: int = field(default=0, init=False)

    def fail_with(
        self, code: str, status: int = 400, detail: str = "The fake was asked to fail"
    ) -> None:
        """Makes the NEXT call fail, once.

        `code` is a value from `aia_errors.ErrorCode`, which is a namespace of
        string constants rather than an enum -- so this takes a `str` and the
        caller writes `ErrorCode.BUDGET_EXHAUSTED` for it.

        A caller's retry, fallback and error message are the parts most likely
        to be wrong and least likely to be exercised, because reproducing an
        exhausted budget against a real platform means exhausting a real budget.
        """
        problem: dict[str, Any] = {
            "type": f"https://aia.dev/errors/{code}",
            "title": "Refused by the fake",
            "status": status,
            "detail": detail,
            "code": code,
            "instance": "/fake",
        }
        if status == 429:
            problem["retry_after"] = 30
        self._next_failure = PlatformError(problem)

    def _check(self) -> None:
        failure = self._next_failure
        if failure is None:
            return
        self._next_failure = None
        raise failure

    def _id(self, prefix: str) -> str:
        self._counter += 1
        # Deterministic, because a test asserting on an id generated from the
        # clock is a test that cannot assert on an id.
        return f"{prefix}-{self._counter:04d}"

    async def chat(
        self, *, model: str, messages: Sequence[Message], max_tokens: int | None = None
    ) -> Completion:
        self._check()
        _ = messages, max_tokens
        return self._completion(model)

    async def chat_stream(
        self, *, model: str, messages: Sequence[Message], max_tokens: int | None = None
    ) -> AsyncIterator[ChatEvent]:
        self._check()
        _ = messages, max_tokens
        # Word by word, because a consumer that concatenates deltas correctly
        # and one that keeps only the last look identical against one chunk.
        for word in self.reply.split(" "):
            yield Delta(content=word)
        yield Finished(completion=self._completion(model))

    async def embed(self, *, model: str, texts: Sequence[str]) -> list[list[float]]:
        self._check()
        _ = model
        return [[(axis + 1) / 10 for axis in range(self.dimensions)] for _text in texts]

    async def models(self) -> list[ModelAlias]:
        self._check()
        return list(self.model_list)

    async def search(
        self, store_id: str, query: str, *, top_k: int | None = None, mode: str | None = None
    ) -> list[SearchHit]:
        self._check()
        _ = store_id, mode
        needle = query.lower()
        found = [document for document in self.documents if needle in document.text.lower()]
        return [
            SearchHit(
                document_id=document.document_id,
                document_title=document.title,
                chunk_index=index,
                score=1 - index / 10,
                retrieval="both",
                text=document.text,
            )
            for index, document in enumerate(found[: top_k or 5])
        ]

    async def start_run(self, agent_id: str, prompt: str, *, thread_id: str | None = None) -> Run:
        self._check()
        _ = prompt, thread_id
        run = Run(
            id=self._id("run"),
            agent_id=agent_id,
            status="completed",
            step=1,
            output=self.reply,
        )
        self._runs[run.id] = run
        return run

    async def get_run(self, run_id: str) -> Run:
        self._check()
        run = self._runs.get(run_id)
        if run is None:
            raise PlatformError(
                {
                    "type": "https://aia.dev/errors/not_found",
                    "title": "Not found",
                    "status": 404,
                    "detail": "run not found",
                    "code": ErrorCode.NOT_FOUND,
                    "instance": f"/v1/runs/{run_id}",
                }
            )
        return run

    async def approve(self, run_id: str, tool_call_id: str, *, approved: bool = True) -> Run:
        self._check()
        _ = tool_call_id
        run = self._runs.get(run_id)
        if run is None or not run.waiting_approval:
            # 409 and not 404: the run exists. A caller approving twice has to
            # be able to tell "already done" from "never existed".
            raise PlatformError(
                {
                    "type": "https://aia.dev/errors/conflict",
                    "title": "State conflict",
                    "status": 409,
                    "detail": "The run is not waiting on that call",
                    "code": ErrorCode.CONFLICT,
                    "instance": f"/v1/runs/{run_id}/approve",
                }
            )
        # A refusal is not a failure: the contract says it "lets the run
        # continue without it", so the run finishes either way and only the
        # answer differs.
        resumed = Run(
            id=run.id,
            agent_id=run.agent_id,
            status="completed",
            step=run.step + 1,
            output=self.reply if approved else "The tool call was refused.",
            pending_call=None,
        )
        self._runs[run_id] = resumed
        return resumed

    def hold_for_approval(self, agent_id: str, tool_name: str) -> Run:
        """Puts a run into `waiting_approval`, so the approval path can be tested."""
        run = Run(
            id=self._id("run"),
            agent_id=agent_id,
            status="waiting_approval",
            step=1,
            output=None,
            pending_call=ToolCall(
                id=self._id("call"), tool_name=tool_name, arguments={}, risk_level="high"
            ),
        )
        self._runs[run.id] = run
        return run

    def _completion(self, model: str) -> Completion:
        return Completion(
            id=self._id("chatcmpl"),
            model=model,
            content=self.reply,
            finish_reason="stop",
            usage=Usage(prompt_tokens=10, completion_tokens=1, total_tokens=11),
            routing=Routing(deployment_id="fake", provider="fake", data_zone="local"),
        )


__all__ = ["Document", "FakeAia"]

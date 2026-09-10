"""What the SDK promises, in both of its implementations."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest

from aia_errors import ErrorCode
from aia_sdk import (
    Aia,
    AiaClient,
    Delta,
    Document,
    FakeAia,
    Finished,
    Message,
    PlatformError,
    TokenSource,
)

COMPLETION = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "chat-local",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11},
    "aia": {
        "deployment_id": "ollama-only",
        "provider": "ollama",
        "data_zone": "local",
        "cost": {"currency": "BRL", "micros": 0},
        "budget_unverified": True,
    },
}

HELLO = [Message(role="user", content="hi")]


Handler = Callable[[httpx.Request], httpx.Response]


def transport(handler: Handler, seen: list[httpx.Request] | None = None) -> httpx.AsyncClient:
    """An `httpx` client that answers from a function instead of a socket."""

    def respond(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(respond))


def client_for(
    handler: Handler, seen: list[httpx.Request] | None = None, token: TokenSource = "a-token"
) -> AiaClient:
    return AiaClient(
        base_url="http://platform.test/",
        project_id="proj-1",
        token=token,
        client=transport(handler, seen),
    )


def problem(status: int, **extra: Any) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "type": "https://aia.dev/errors/budget_exhausted",
            "title": "Budget exhausted",
            "status": status,
            "detail": "The project has spent its monthly budget",
            "code": ErrorCode.BUDGET_EXHAUSTED,
            "instance": "/v1/chat/completions",
            **extra,
        },
        headers={"Content-Type": "application/problem+json"},
    )


# --- the tenant and the credential -----------------------------------------


async def test_the_project_travels_on_every_request() -> None:
    seen: list[httpx.Request] = []
    await client_for(lambda _r: httpx.Response(200, json=COMPLETION), seen).chat(
        model="chat-local", messages=HELLO
    )

    # The whole reason this lives in the client: `X-Project-Id` forgotten on one
    # call out of forty is a 400 in production and nowhere else.
    assert seen[0].headers["X-Project-Id"] == "proj-1"
    assert seen[0].headers["Authorization"] == "Bearer a-token"


async def test_a_token_source_is_asked_again_every_call() -> None:
    issued = 0

    def next_token() -> str:
        nonlocal issued
        issued += 1
        return f"token-{issued}"

    seen: list[httpx.Request] = []
    subject = client_for(lambda _r: httpx.Response(200, json=COMPLETION), seen, token=next_token)
    await subject.chat(model="chat-local", messages=HELLO)
    await subject.chat(model="chat-local", messages=HELLO)

    # Caching the first one is how a long-lived process starts answering 401 an
    # hour after it started.
    assert seen[1].headers["Authorization"] == "Bearer token-2"


async def test_an_async_token_source_is_awaited() -> None:
    async def next_token() -> str:
        return "async-token"

    seen: list[httpx.Request] = []
    await client_for(lambda _r: httpx.Response(200, json=COMPLETION), seen, token=next_token).chat(
        model="chat-local", messages=HELLO
    )
    # Without the await the header would read "Bearer <coroutine object ...>",
    # which the platform rejects with a 401 nobody can explain.
    assert seen[0].headers["Authorization"] == "Bearer async-token"


async def test_a_trailing_slash_does_not_double() -> None:
    seen: list[httpx.Request] = []
    await client_for(lambda _r: httpx.Response(200, json=COMPLETION), seen).chat(
        model="chat-local", messages=HELLO
    )
    assert str(seen[0].url) == "http://platform.test/v1/chat/completions"


async def test_the_routing_metadata_survives_the_trip() -> None:
    result = await client_for(lambda _r: httpx.Response(200, json=COMPLETION)).chat(
        model="chat-local", messages=HELLO
    )
    assert result.routing.data_zone == "local"
    assert result.routing.provider == "ollama"
    # A caller that ignores this is billing against a number nobody checked.
    assert result.routing.budget_unverified is True


# --- what the platform refused ---------------------------------------------


async def test_a_refusal_carries_the_code_the_status_and_the_trace() -> None:
    with pytest.raises(PlatformError) as raised:
        await client_for(lambda _r: problem(429, retry_after=30, trace_id="abc123")).chat(
            model="chat-local", messages=HELLO
        )

    assert raised.value.code == "budget_exhausted"
    assert raised.value.status == 429
    assert raised.value.retry_after_seconds == 30
    # Without this a bug report says "it failed" and nobody can find the trace.
    assert raised.value.trace_id == "abc123"


async def test_html_from_a_proxy_is_still_reported_as_its_status() -> None:
    with pytest.raises(PlatformError) as raised:
        await client_for(
            lambda _r: httpx.Response(
                502, text="<html>502 Bad Gateway</html>", headers={"Content-Type": "text/html"}
            )
        ).models()

    # A decode error naming a byte offset would hide the only fact that is
    # always known: the status.
    assert raised.value.status == 502
    assert "502" in str(raised.value)


# --- streaming ---------------------------------------------------------------


def sse_response(chunks: list[bytes]) -> httpx.Response:
    async def stream() -> AsyncIterator[bytes]:
        for chunk in chunks:
            yield chunk

    return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=stream())


async def test_a_frame_split_across_chunks_is_reassembled() -> None:
    # One frame arriving in two pieces is the normal case on a real network and
    # never happens against a fake that returns whole frames.
    response = sse_response(
        [
            b'event: message.delta\ndata: {"delta":{"con',
            b'tent":"hello"}}\n\n',
            f"event: run.finished\ndata: {json.dumps(COMPLETION)}\n\n".encode(),
        ]
    )
    events = [
        event
        async for event in client_for(lambda _r: response).chat_stream(
            model="chat-local", messages=HELLO
        )
    ]

    assert events[0] == Delta(content="hello")
    assert isinstance(events[1], Finished)
    assert events[1].completion.content == "ok"


async def test_the_heartbeat_is_not_an_event() -> None:
    response = sse_response(
        [b": ping\n\n", b'event: message.delta\ndata: {"delta":{"content":"hi"}}\n\n']
    )
    events = [
        event
        async for event in client_for(lambda _r: response).chat_stream(
            model="chat-local", messages=HELLO
        )
    ]

    # A comment frame keeps a proxy from dropping the connection and means
    # nothing to the caller. Surfacing it as an empty delta would have every
    # consumer filtering it out.
    assert events == [Delta(content="hi")]


async def test_a_failure_inside_the_stream_arrives_as_an_event() -> None:
    response = sse_response(
        [b'event: error\ndata: {"code":"stream_interrupted","message":"upstream closed"}\n\n']
    )
    events = [
        event
        async for event in client_for(lambda _r: response).chat_stream(
            model="chat-local", messages=HELLO
        )
    ]

    # The headers are long gone by then, so the status cannot say it. A consumer
    # that only watches for an exception would call this a success.
    assert len(events) == 1
    assert getattr(events[0], "code", "") == "stream_interrupted"


async def test_a_complete_frame_with_broken_json_is_dropped() -> None:
    """Not the same as a truncated stream, and that is why it needs its own test.

    A frame cut off mid-flight never gets its blank line, so the parser simply
    never sees it. This one is complete -- boundary and all -- and its payload
    is broken, which is what a proxy that rewrites a body produces. Read as an
    empty object it would become a `Finished` carrying an empty completion, and
    the caller would report an answer the model never gave.
    """
    response = sse_response(
        [
            b'event: message.delta\ndata: {"delta":{"content":"real"}}\n\n',
            b'event: run.finished\ndata: {"model":\n\n',
        ]
    )
    events = [
        event
        async for event in client_for(lambda _r: response).chat_stream(
            model="chat-local", messages=HELLO
        )
    ]

    assert events == [Delta(content="real")]


async def test_a_failure_before_the_first_event_raises() -> None:
    stream = client_for(lambda _r: problem(429)).chat_stream(model="chat-local", messages=HELLO)
    with pytest.raises(PlatformError):
        await anext(stream)


# --- the design test ---------------------------------------------------------


def implementations() -> list[tuple[str, Aia]]:
    """Whatever is written against `Aia` must work against both.

    If a test has to know which one it holds, the transport has leaked into the
    interface.
    """

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "chat-local"}]})
        return httpx.Response(200, json=COMPLETION)

    return [("fake", FakeAia()), ("client", client_for(answer))]


@pytest.mark.parametrize(("name", "platform"), implementations())
async def test_both_implementations_answer_a_completion(name: str, platform: Aia) -> None:
    _ = name
    result = await platform.chat(model="chat-local", messages=HELLO)
    assert result.model == "chat-local"
    assert result.content == "ok"


@pytest.mark.parametrize(("name", "platform"), implementations())
async def test_both_implementations_list_an_alias(name: str, platform: Aia) -> None:
    _ = name
    assert (await platform.models())[0].id == "chat-local"


# --- the fake, as a test double ---------------------------------------------


async def test_the_fake_needs_no_credential_no_container_no_network() -> None:
    # The point of the package. If this ever needs a URL or a token, the
    # interface has leaked its transport.
    platform = FakeAia(reply="the answer")
    assert (await platform.chat(model="chat-local", messages=[])).content == "the answer"


async def test_the_fake_reproduces_a_refusal_you_would_otherwise_have_to_earn() -> None:
    platform = FakeAia()
    platform.fail_with(ErrorCode.BUDGET_EXHAUSTED, 429)

    with pytest.raises(PlatformError) as raised:
        await platform.chat(model="chat-local", messages=[])
    assert raised.value.code == "budget_exhausted"
    assert raised.value.retry_after_seconds == 30

    # Once. A failure that stuck would make every later call in the test fail
    # for a reason the test never asked for.
    assert (await platform.chat(model="chat-local", messages=[])).content == "ok"


async def test_the_fake_streams_more_than_one_delta() -> None:
    platform = FakeAia(reply="one two three")
    contents = [
        event.content
        async for event in platform.chat_stream(model="chat-local", messages=[])
        if isinstance(event, Delta)
    ]
    # A consumer that keeps only the last delta and one that concatenates them
    # look identical against a single chunk.
    assert contents == ["one", "two", "three"]


async def test_the_fake_holds_a_run_for_approval_and_resumes_it() -> None:
    platform = FakeAia()
    held = platform.hold_for_approval("agent-1", "file_search")
    assert held.waiting_approval
    assert held.pending_call is not None

    resumed = await platform.approve(held.id, held.pending_call.id)
    assert resumed.status == "completed"
    assert resumed.pending_call is None


async def test_the_fake_refuses_to_approve_a_run_that_is_not_waiting() -> None:
    platform = FakeAia()
    run = await platform.start_run("agent-1", "hello")

    with pytest.raises(PlatformError) as raised:
        await platform.approve(run.id, "call-1")

    # 409 and not 404: the run exists. A caller approving twice has to be able
    # to tell "already done" from "never existed".
    assert raised.value.status == 409


async def test_a_refused_call_still_finishes_the_run() -> None:
    platform = FakeAia()
    held = platform.hold_for_approval("agent-1", "file_search")
    assert held.pending_call is not None

    resumed = await platform.approve(held.id, held.pending_call.id, approved=False)
    # The contract says a refusal "lets the run continue without it", so the run
    # completes either way and only the answer differs.
    assert resumed.status == "completed"
    assert resumed.output == "The tool call was refused."


async def test_the_fake_searches_what_it_was_given_and_nothing_else() -> None:
    platform = FakeAia(
        documents=(Document(document_id="doc-1", title="Runbook", text="the code is ZORBLAX-7741"),)
    )

    assert len(await platform.search("store-1", "zorblax")) == 1
    assert await platform.search("store-1", "nothing here") == []

"""A request produces a span, and the business attributes reach it.

This is the test whose absence let the platform ship two instrumentation
packages in every Python image and import neither. `annotate_active_span`
writes onto whatever `get_current_span()` returns, and with nothing installed
that is `INVALID_SPAN` -- a non-recording object whose `set_attribute` accepts
anything and keeps nothing. Guardrails set a decision on every inspection and
not one reached a backend, and no test noticed because nothing asserted on the
far end of the pipe.

So these assert on the far end: a real SDK tracer provider with an in-memory
exporter, and the exported spans read back.
"""

from __future__ import annotations

from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Annotated

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aia_fastapi import (
    AuthenticatedCaller,
    PlatformSettings,
    authenticated,
    create_app,
    health_router,
)
from aia_telemetry import AiaAttr, instrument_fastapi, start_telemetry

from .test_app import VERIFIER, headers  # the fake verifier and header helper


@pytest.fixture
def exported() -> Iterator[InMemorySpanExporter]:
    """Listens to the REAL provider rather than replacing it.

    Swapping the global provider was the obvious approach and it is wrong here:
    an instrumentor resolves its tracer when it is installed, so the httpx one
    -- installed once per process, from the first `create_app` -- holds a tracer
    bound to whatever provider existed then. A test that substitutes a provider
    afterwards sees nothing and concludes the instrumentation is broken.

    Adding a processor to the provider the platform actually installed observes
    the pipeline instead of a stand-in for it.
    """
    exporter = InMemorySpanExporter()
    start_telemetry("aia-fastapi-tests")  # idempotent; the first caller wins

    provider = trace.get_tracer_provider()
    assert isinstance(provider, TracerProvider), (
        "start_telemetry installed no real provider, so nothing here can be observed"
    )

    processor = SimpleSpanProcessor(exporter)
    provider.add_span_processor(processor)
    try:
        yield exporter
    finally:
        # A processor cannot be detached, so it is stopped instead: after this
        # the exporter refuses exports and cannot leak spans into another test.
        processor.shutdown()


Caller = Annotated[AuthenticatedCaller, authenticated(lambda: VERIFIER)]


def instrumented_app() -> FastAPI:
    router = APIRouter()

    @router.get("/v1/whoami")
    def whoami(caller: Caller) -> dict[str, str]:
        return {"principal_id": caller.principal.id}

    return create_app(
        service_name="aia-test",
        title="Test",
        settings=PlatformSettings(),
        routers=(router, health_router()),
    )


def spans_of(exporter: InMemorySpanExporter) -> list[ReadableSpan]:
    return list(exporter.get_finished_spans())


def test_a_request_produces_a_server_span(exported: InMemorySpanExporter) -> None:
    TestClient(instrumented_app()).get("/v1/whoami", headers=headers())

    # Before the instrumentor was installed this was zero, for every route of
    # every Python service.
    assert spans_of(exported), "the request produced no span at all"


def test_the_business_attributes_reach_the_span(exported: InMemorySpanExporter) -> None:
    """ADR-009: every span carries `aia.project_id`."""
    TestClient(instrumented_app()).get("/v1/whoami", headers=headers())

    attributes = [dict(span.attributes or {}) for span in spans_of(exported)]
    carrying = [a for a in attributes if AiaAttr.PROJECT_ID in a]

    assert carrying, f"no span carried {AiaAttr.PROJECT_ID}: {attributes}"
    assert carrying[0][AiaAttr.PROJECT_ID] == "proj-1"
    assert carrying[0][AiaAttr.PRINCIPAL_ID] == "user-1"
    assert carrying[0][AiaAttr.PRINCIPAL_TYPE] == "user"


def test_a_refused_request_still_produces_a_span(exported: InMemorySpanExporter) -> None:
    """The refusals are the ones worth finding in a backend.

    A 403 that appears nowhere is a support ticket nobody can answer.
    """
    TestClient(instrumented_app()).get("/v1/whoami", headers=headers("outsider"))

    statuses = [
        (span.attributes or {}).get("http.response.status_code")
        or (span.attributes or {}).get("http.status_code")
        for span in spans_of(exported)
    ]
    assert 403 in statuses, f"no span recorded the refusal: {statuses}"


def test_instrumenting_a_started_application_does_nothing_and_says_nothing(
    exported: InMemorySpanExporter,
) -> None:
    """Why `create_app` instruments at CONSTRUCTION and not from the lifespan.

    The constraint is stated as a test rather than as a comment somebody can
    move code past -- and the way it fails is the reason it needs one. Starlette
    builds its middleware stack when the application starts, so an instrumentor
    installed afterwards is simply not in the stack. It does not raise. It does
    not warn. Every request afterwards produces nothing, which reads exactly
    like a service with no traffic.
    """
    app = FastAPI()

    @app.get("/x")
    def handler() -> dict[str, str]:
        return {"ok": "yes"}

    with TestClient(app) as client:  # entering the context starts the application
        instrument_fastapi(app)
        exported.clear()
        client.get("/x")

    assert not spans_of(exported), "instrumenting after start unexpectedly worked"

    # The same application, instrumented before it starts, does produce spans --
    # so the assertion above is about the ORDER and not about a broken helper.
    ordered = FastAPI()

    @ordered.get("/x")
    def ordered_handler() -> dict[str, str]:
        return {"ok": "yes"}

    instrument_fastapi(ordered)
    exported.clear()
    with TestClient(ordered) as client:
        client.get("/x")

    assert spans_of(exported)


async def test_an_outbound_call_carries_the_trace_to_the_next_service(
    exported: InMemorySpanExporter,
) -> None:
    """A trace has to survive the service boundary.

    The assertion is on the `traceparent` HEADER the downstream service
    receives, not on a span count, because that header is what actually makes a
    distributed trace: without it agent-runtime's call to the router starts a
    new trace, and a run that crossed three services arrives in a backend as
    three unrelated ones that no query can put back together.

    A real socket, and not `httpx.MockTransport`, because the instrumentor
    wraps `AsyncHTTPTransport.handle_async_request` -- a mock transport is a
    different class and is never wrapped, so a test built on one passes or
    fails for reasons that have nothing to do with the platform.
    """
    import httpx

    from aia_telemetry import get_tracer

    seen: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            seen.update(self.headers)
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_: object) -> None:
            """Silence: the default writes every request to stderr."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with get_tracer("test").start_as_current_span("caller") as parent:
            expected = format(parent.get_span_context().trace_id, "032x")
            async with httpx.AsyncClient() as client:
                await client.get(f"http://127.0.0.1:{server.server_port}/downstream")
    finally:
        server.shutdown()
        server.server_close()

    assert "traceparent" in seen, f"the outgoing request carried no traceparent: {sorted(seen)}"
    assert expected in seen["traceparent"], (
        f"it opened its own trace: {seen['traceparent']} does not carry {expected}"
    )


def test_liveness_is_not_traced(exported: InMemorySpanExporter) -> None:
    """A probe every ten seconds is the platform's highest-volume route and says
    nothing about it. Tracing it buys noise and a bill."""
    TestClient(instrumented_app()).get("/health/live")

    assert not spans_of(exported), "the liveness probe was traced"

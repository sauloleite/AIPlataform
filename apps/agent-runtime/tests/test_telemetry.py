"""What an agent run leaves behind in a trace.

The runtime produced no span of any kind: the platform's longest and most
expensive operation, the one that spends a budget and calls tools on somebody's
behalf, was invisible. These assert on EXPORTED spans, because the failure being
guarded against is not a function going uncalled — it is an attribute or a
parent that never arrives, and a test on a spy cannot tell the difference.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from agent_fakes import ScriptedModel, a_tool_call
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from test_run_agent import Harness, first

from aia_telemetry import AiaAttr, start_telemetry


@pytest.fixture
def exported() -> Iterator[InMemorySpanExporter]:
    """Listens to the provider the platform installed, rather than replacing it."""
    exporter = InMemorySpanExporter()
    start_telemetry("aia-agent-runtime-tests")

    provider = trace.get_tracer_provider()
    assert isinstance(provider, TracerProvider), "no real provider to observe"

    processor = SimpleSpanProcessor(exporter)
    provider.add_span_processor(processor)
    try:
        yield exporter
    finally:
        processor.shutdown()


def named(exporter: InMemorySpanExporter, prefix: str) -> list[ReadableSpan]:
    return [span for span in exporter.get_finished_spans() if span.name.startswith(prefix)]


def answering(text: str = "You get 30 days.") -> ScriptedModel:
    return ScriptedModel(turns=[(text, [])])


class TestTheRunItself:
    async def test_a_run_produces_a_span_named_by_the_conventions(
        self, exported: InMemorySpanExporter
    ) -> None:
        await Harness(answering()).start()

        runs = named(exported, "invoke_agent")
        assert runs, "the agent run produced no span"
        assert runs[0].name == "invoke_agent agent-1"

    async def test_the_span_carries_the_thread_as_the_conversation(
        self, exported: InMemorySpanExporter
    ) -> None:
        events = await Harness(answering()).start()
        thread = first(events, "run.started").data["thread_id"]

        span = named(exported, "invoke_agent")[0]
        attributes = dict(span.attributes or {})
        # `gen_ai.conversation.id` is what ties this run to the one before it,
        # and it is the name a backend's GenAI view looks for. The platform
        # carried a thread id from the first commit and put it nowhere a query
        # could reach.
        assert attributes["gen_ai.conversation.id"] == thread
        assert attributes[AiaAttr.PROJECT_ID] == "proj-1"
        assert attributes[AiaAttr.PRINCIPAL_ID] == "user-ana"

    async def test_the_span_records_how_the_run_ended(self, exported: InMemorySpanExporter) -> None:
        await Harness(answering()).start()

        attributes = dict(named(exported, "invoke_agent")[0].attributes or {})
        assert attributes["aia.run.status"] == "completed"
        assert attributes["aia.run.steps"] == 1


class TestTheToolCall:
    """The highest-risk thing the platform does, and it had no span at all."""

    def _harness(self) -> Harness:
        return Harness(
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("merge-request", '{"mr":42}')]),
                    ("Merged.", []),
                ]
            )
        )

    async def test_an_approved_call_is_a_span_that_says_a_person_allowed_it(
        self, exported: InMemorySpanExporter
    ) -> None:
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]

        await harness.approve(run_id, call_id)

        tools = named(exported, "execute_tool")
        assert tools, "the tool call produced no span"
        attributes = dict(tools[0].attributes or {})
        assert attributes["gen_ai.tool.name"] == "merge-request"
        assert attributes["aia.tool.risk_level"] == "high"
        # An audit of the approval gate asks exactly this question, and the
        # answer used to exist only in a Mongo collection.
        assert attributes["aia.tool.human_approved"] is True

    async def test_a_call_that_never_ran_produces_no_span(
        self, exported: InMemorySpanExporter
    ) -> None:
        # The run stops at `waiting_approval`. A span for a call that was only
        # proposed would make the trace claim the tool ran.
        await self._harness().start()

        assert named(exported, "execute_tool") == []

    async def test_the_tool_span_is_a_child_of_the_run(
        self, exported: InMemorySpanExporter
    ) -> None:
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]
        await harness.approve(run_id, call_id)

        tool = named(exported, "execute_tool")[0]
        runs = {span.context.span_id for span in named(exported, "invoke_agent") if span.context}

        # The run's span is deliberately NOT made current -- it would leak
        # across every `yield` of an async generator -- so the parent is passed
        # explicitly. Without that this assertion fails and the trace is a flat
        # list of siblings with nothing saying which run a tool call belongs to.
        assert tool.parent is not None
        assert tool.parent.span_id in runs


class TestASegmentPerDecision:
    async def test_a_run_waiting_on_a_person_closes_its_span(
        self, exported: InMemorySpanExporter
    ) -> None:
        harness = Harness(
            ScriptedModel(turns=[("", [a_tool_call("merge-request", '{"mr":42}')]), ("Done.", [])])
        )

        await harness.start()

        # An unfinished span is never exported. Holding one open across a human
        # decision means the run is invisible until somebody makes it -- which
        # may be tomorrow.
        runs = named(exported, "invoke_agent")
        assert runs, "the paused run exported no span"
        assert dict(runs[0].attributes or {})["aia.run.status"] == "waiting_approval"

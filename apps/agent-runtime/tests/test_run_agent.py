"""Flow 7.2: an agent run with tool calls and human approval.

Every path here is an error path or a control path. The happy case — model
answers, run finishes — is the easiest and the least informative.
"""

from __future__ import annotations

from dataclasses import replace

import pytest
from agent_fakes import (
    MERGE,
    SEARCH,
    UNAVAILABLE,
    FakeAgentSource,
    FakeToolCatalog,
    FakeToolGateway,
    ScriptedModel,
    a_tool_call,
)

from agent_runtime.application.dto import ApproveToolCallCommand, Caller, RunEvent, StartRunCommand
from agent_runtime.application.use_cases.run_agent import RunAgent
from agent_runtime.domain.errors import (
    AgentNotPublishedError,
    ApprovalForbiddenError,
    RunNotFoundError,
    RunNotWaitingApprovalError,
)
from agent_runtime.infrastructure.in_memory import InMemoryCheckpointer, InMemoryRunRepository
from aia_messaging import EventType, InMemoryEventPublisher

OWNER = Caller(
    principal_id="user-ana",
    project_id="proj-1",
    access_token="ana-token",
    roles=frozenset({"project_owner"}),
)
VIEWER = Caller(
    principal_id="user-bea",
    project_id="proj-1",
    access_token="bea-token",
    roles=frozenset({"project_viewer"}),
)


class Harness:
    def __init__(self, model: ScriptedModel, max_steps: int = 12) -> None:
        self.runs = InMemoryRunRepository()
        self.checkpointer = InMemoryCheckpointer()
        self.agents = FakeAgentSource()
        self.catalog = FakeToolCatalog()
        self.tools = FakeToolGateway()
        self.model = model
        self.events = InMemoryEventPublisher()
        self.use_case = RunAgent(
            runs=self.runs,
            checkpointer=self.checkpointer,
            agents=self.agents,
            catalog=self.catalog,
            tools=self.tools,
            model=model,
            events=self.events,
            max_steps=max_steps,
        )

    async def start(self, text: str = "how much leave do I get?") -> list[RunEvent]:
        command = StartRunCommand(agent_id="agent-1", caller=OWNER, input=text)
        return [event async for event in self.use_case.start(command)]

    async def approve(
        self, run_id: str, call_id: str, caller: Caller = OWNER, approved: bool = True
    ) -> list[RunEvent]:
        command = ApproveToolCallCommand(
            run_id=run_id, tool_call_id=call_id, caller=caller, approved=approved
        )
        return [event async for event in self.use_case.resume(command)]


def kinds(events: list[RunEvent]) -> list[str]:
    return [event.kind for event in events]


def first(events: list[RunEvent], kind: str) -> RunEvent:
    return next(event for event in events if event.kind == kind)


def answering(text: str = "You get 30 days.") -> ScriptedModel:
    return ScriptedModel(turns=[(text, [])])


class TestAPlainAnswer:
    async def test_streams_the_text_and_finishes(self) -> None:
        harness = Harness(answering())

        events = await harness.start()

        assert kinds(events) == ["run.started", "message.delta", "message.delta", "run.finished"]
        assert "".join(e.data["content"] for e in events if e.kind == "message.delta") == (
            "You get 30 days."
        )
        assert first(events, "run.finished").data["status"] == "completed"

    async def test_pins_the_published_version_for_the_whole_run(self) -> None:
        harness = Harness(answering())

        events = await harness.start()

        assert first(events, "run.started").data["agent_version"] == 3

    async def test_publishes_one_finished_event(self) -> None:
        harness = Harness(answering())

        await harness.start()

        published = harness.events.of_type(EventType.AGENT_RUN_FINISHED)
        assert len(published) == 1
        assert published[0].subject == "proj-1"
        assert published[0].data["status"] == "completed"

    async def test_carries_the_callers_token_to_every_dependency(self) -> None:
        # ADR-017: the registry, the gateway and the router each authorise the
        # PERSON. A service credential is a member of no project and would sail
        # past a check the user would have failed.
        harness = Harness(answering())

        await harness.start()

        assert harness.agents.tokens_seen == ["ana-token"]
        assert harness.catalog.tokens_seen == ["ana-token"]
        assert harness.model.calls[0]["access_token"] == "ana-token"


class TestTools:
    async def test_runs_a_low_risk_tool_and_feeds_the_result_back(self) -> None:
        harness = Harness(
            ScriptedModel(turns=[("", [a_tool_call("knowledge-search")]), ("You get 30 days.", [])])
        )

        events = await harness.start()

        assert "tool.call" in kinds(events)
        assert first(events, "tool.result").data["status"] == "ok"
        # The second turn must see the result, or the model answers blind.
        second_turn = harness.model.calls[1]["messages"]
        assert second_turn[-1]["role"] == "tool"
        assert "30 days of leave" in second_turn[-1]["content"]

    async def test_declares_only_the_tools_the_project_allows(self) -> None:
        # The agent names two; the project withdrew one. The intersection wins:
        # telling the model about a tool the gateway will refuse buys a wasted
        # turn and an error the user has to read.
        harness = Harness(answering())
        harness.catalog.tools = [SEARCH]

        await harness.start()

        declared = harness.model.calls[0]["tools"]
        assert [tool["function"]["name"] for tool in declared] == ["knowledge-search"]

    async def test_declares_no_tools_when_the_project_allows_none(self) -> None:
        harness = Harness(answering())
        harness.catalog.tools = []

        await harness.start()

        assert harness.model.calls[0]["tools"] is None

    async def test_tells_the_model_when_it_invented_a_tool_name(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[("", [a_tool_call("delete_everything")]), ("I cannot do that.", [])]
            )
        )

        events = await harness.start()

        assert first(events, "tool.result").data["status"] == "unknown_tool"
        assert harness.tools.invocations == []
        # It reaches the model as a result, so it can say what it could not do.
        assert "No tool named" in harness.model.calls[1]["messages"][-1]["content"]

    async def test_a_refused_tool_becomes_a_result_rather_than_ending_the_run(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[("", [a_tool_call("knowledge-search")]), ("I could not look it up.", [])]
            )
        )
        harness.tools.fail_with("tool_rate_limited", "Called too often", status=429)

        events = await harness.start()

        assert first(events, "tool.result").data["status"] == "failed"
        assert first(events, "run.finished").data["status"] == "completed"
        assert "tool_rate_limited" in harness.model.calls[1]["messages"][-1]["content"]

    async def test_a_tool_endpoint_that_is_down_is_reported_the_same_way(self) -> None:
        harness = Harness(
            ScriptedModel(turns=[("", [a_tool_call("knowledge-search")]), ("Sorry.", [])])
        )
        harness.tools.failure = UNAVAILABLE

        events = await harness.start()

        assert first(events, "tool.result").data["status"] == "failed"
        assert first(events, "run.finished").data["status"] == "completed"


class TestApproval:
    """OWASP LLM06, excessive agency: a high-risk tool waits for a person."""

    def _harness(self) -> Harness:
        return Harness(
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("merge-request", '{"mr":42}')]),
                    ("Merged.", []),
                ]
            )
        )

    async def test_stops_before_running_a_high_risk_tool(self) -> None:
        harness = self._harness()

        events = await harness.start()

        assert kinds(events)[-1] == "approval.requested"
        assert harness.tools.invocations == []
        assert first(events, "approval.requested").data["risk_level"] == "high"

    async def test_holds_the_run_resumable_rather_than_failing_it(self) -> None:
        harness = self._harness()

        events = await harness.start()
        run_id = first(events, "run.started").data["run_id"]

        view = await harness.use_case.view(run_id)
        assert view.status == "waiting_approval"
        assert view.pending_call is not None
        assert view.pending_call.tool_name == "merge-request"

    async def test_publishes_an_approval_event_for_whoever_is_not_watching(self) -> None:
        harness = self._harness()

        await harness.start()

        published = harness.events.of_type(EventType.APPROVAL_REQUESTED)
        assert len(published) == 1
        assert published[0].data["tool_name"] == "merge-request"

    async def test_an_owner_approves_and_the_run_carries_on(self) -> None:
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]

        events = await harness.approve(run_id, call_id)

        assert len(harness.tools.invocations) == 1
        assert first(events, "run.finished").data["status"] == "completed"

    async def test_a_viewer_cannot_approve_and_nothing_runs(self) -> None:
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]

        with pytest.raises(ApprovalForbiddenError):
            await harness.approve(run_id, call_id, caller=VIEWER)

        # The point of the control: the tool did NOT run.
        assert harness.tools.invocations == []

    async def test_an_approval_naming_another_call_is_refused(self) -> None:
        # Without this an approval granted for one call would authorise
        # whatever the run happened to move on to.
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]

        with pytest.raises(RunNotWaitingApprovalError):
            await harness.approve(run_id, "call_someone_else")

        assert harness.tools.invocations == []

    async def test_a_refusal_goes_back_to_the_model_instead_of_failing_the_run(self) -> None:
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]

        events = await harness.approve(run_id, call_id, approved=False)

        assert harness.tools.invocations == []
        assert first(events, "tool.result").data["status"] == "denied"
        assert first(events, "run.finished").data["status"] == "completed"

    async def test_a_run_that_already_finished_cannot_be_approved(self) -> None:
        harness = Harness(answering())
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]

        with pytest.raises(RunNotWaitingApprovalError):
            await harness.approve(run_id, "call_1")

    async def test_a_run_from_another_project_answers_not_found(self) -> None:
        # Not "forbidden": confirming it exists hands over information about
        # the neighbouring tenant.
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]
        intruder = Caller(
            principal_id="user-carl",
            project_id="proj-2",
            access_token="carl",
            roles=frozenset({"project_owner"}),
        )

        with pytest.raises(RunNotFoundError):
            await harness.approve(run_id, call_id, caller=intruder)

    async def test_resuming_a_run_that_never_existed(self) -> None:
        harness = Harness(answering())

        with pytest.raises(RunNotFoundError):
            await harness.approve("no-such-run", "call_1")


class TestABatchOfCalls:
    """A model can ask for several calls in one turn."""

    async def test_a_held_call_does_not_swallow_the_ones_after_it(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[
                    (
                        "",
                        [
                            a_tool_call("merge-request", '{"mr":42}', "call_a"),
                            a_tool_call("knowledge-search", '{"query":"x"}', "call_b"),
                        ],
                    ),
                    ("Both done.", []),
                ]
            )
        )

        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        assert kinds(started)[-1] == "approval.requested"

        events = await harness.approve(run_id, "call_a")

        # Both ran, in the order the model asked for them.
        assert [call.tool_name for call, _, _ in harness.tools.invocations] == [
            "merge-request",
            "knowledge-search",
        ]
        assert first(events, "run.finished").data["status"] == "completed"

    async def test_a_second_high_risk_call_stops_the_run_again(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[
                    (
                        "",
                        [
                            a_tool_call("merge-request", '{"mr":1}', "call_a"),
                            a_tool_call("merge-request", '{"mr":2}', "call_b"),
                        ],
                    ),
                    ("Done.", []),
                ]
            )
        )
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]

        events = await harness.approve(run_id, "call_a")

        # One approval authorises one call, not the batch it arrived in.
        assert kinds(events)[-1] == "approval.requested"
        assert first(events, "approval.requested").data["tool_call_id"] == "call_b"
        assert len(harness.tools.invocations) == 1


class TestTheLoopEnds:
    async def test_warns_the_model_one_step_before_the_ceiling(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("knowledge-search")]),
                    ("What I found is enough.", []),
                ]
            ),
            max_steps=2,
        )

        await harness.start()

        # On the last turn the model is told to answer, and gets no tools to
        # call: a run should end with an answer, not with a limit.
        last = harness.model.calls[-1]
        assert last["tools"] is None
        assert last["messages"][-1]["role"] == "system"

    async def test_fails_with_a_step_limit_when_it_never_stops(self) -> None:
        harness = Harness(
            ScriptedModel(turns=[("", [a_tool_call("knowledge-search")])] * 6), max_steps=3
        )

        events = await harness.start()

        finished = first(events, "run.finished").data
        assert finished["status"] == "failed"
        assert finished["error_code"] == "agent_step_limit"
        # Still published: a run that ends badly is what an operator needs.
        assert len(harness.events.of_type(EventType.AGENT_RUN_FINISHED)) == 1


class TestFailures:
    async def test_an_agent_with_no_published_version_never_creates_a_run(self) -> None:
        harness = Harness(answering())
        harness.agents.failure = AgentNotPublishedError("agent-1")

        with pytest.raises(AgentNotPublishedError):
            await harness.start()

    async def test_a_model_failure_fails_the_run_and_says_why(self) -> None:
        harness = Harness(answering())
        harness.model.failure = UNAVAILABLE

        events = await harness.start()

        assert first(events, "error").data["code"] == "tool_execution_failed"
        assert first(events, "run.finished").data["status"] == "failed"

    async def test_the_run_is_checkpointed_before_the_first_model_call(self) -> None:
        # If the process dies in flight the run exists and can be resumed,
        # rather than vanishing without a trace.
        harness = Harness(answering())
        harness.model.failure = UNAVAILABLE

        events = await harness.start()
        run_id = first(events, "run.started").data["run_id"]

        state = await harness.checkpointer.load(run_id)
        assert state is not None
        assert state.messages[0]["role"] == "system"
        assert state.messages[1]["content"] == "how much leave do I get?"


class TestTheBlockingEndpoint:
    async def test_runs_the_same_loop_and_returns_the_final_view(self) -> None:
        harness = Harness(answering("You get 30 days."))

        view = await harness.use_case.start_and_wait(
            StartRunCommand(agent_id="agent-1", caller=OWNER, input="how much leave?")
        )

        assert view.status == "completed"
        assert view.output == "You get 30 days."
        assert view.agent_version == 3

    async def test_reports_a_run_waiting_on_a_person(self) -> None:
        harness = Harness(
            ScriptedModel(turns=[("", [a_tool_call("merge-request", '{"mr":42}')]), ("ok", [])])
        )

        view = await harness.use_case.start_and_wait(
            StartRunCommand(agent_id="agent-1", caller=OWNER, input="merge it")
        )

        assert view.status == "waiting_approval"
        assert view.pending_call is not None
        assert view.pending_call.risk_level == "high"


def test_the_high_risk_tool_used_here_really_is_high_risk() -> None:
    # Guards the fixtures themselves: if MERGE stopped being high risk, every
    # approval test above would pass by doing nothing.
    assert MERGE.risk_level == "high"
    assert SEARCH.risk_level == "low"


class TestRetrieval:
    """`file_search` searches the store the AGENT was attached to."""

    async def test_supplies_the_store_the_model_was_never_told_about(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[("", [a_tool_call("knowledge-search", '{"query":"leave"}')]), ("30.", [])]
            )
        )

        await harness.start()

        [(call, _, _)] = harness.tools.invocations
        assert call.arguments == {"query": "leave", "store_id": "store-1"}

    async def test_refuses_a_store_this_agent_was_not_attached_to(self) -> None:
        harness = Harness(
            ScriptedModel(
                turns=[
                    (
                        "",
                        [
                            a_tool_call(
                                "knowledge-search",
                                '{"query":"salaries","store_id":"hr-private"}',
                            )
                        ],
                    ),
                    ("I cannot read that.", []),
                ]
            )
        )

        events = await harness.start()

        # Never sent. Inside one project the tenant filter would not have caught
        # it, because the tenant is the same.
        assert harness.tools.invocations == []
        assert first(events, "tool.result").data["status"] == "blocked"
        assert "not attached" in harness.model.calls[1]["messages"][-1]["content"]

    async def test_a_blocked_call_never_asks_a_person_to_approve_it(self) -> None:
        # Nothing that will not run should reach a human for a decision.
        harness = Harness(
            ScriptedModel(
                turns=[
                    ("", [a_tool_call("knowledge-search", '{"query":"x","store_id":"other"}')]),
                    ("Done.", []),
                ]
            )
        )
        harness.catalog.tools = [replace(SEARCH, risk_level="high", requires_approval=True)]

        events = await harness.start()

        assert "approval.requested" not in kinds(events)
        assert first(events, "run.finished").data["status"] == "completed"


class TestTheApprovalReachesTheGateway:
    """The gateway holds high-risk calls too. Two controls, one decision.

    Left alone they deadlock: the runtime asks a person, the person says yes,
    and the gateway then asks a person nobody is there to be.
    """

    def _harness(self) -> Harness:
        return Harness(
            ScriptedModel(
                turns=[("", [a_tool_call("merge-request", '{"mr":42}')]), ("Merged.", [])]
            )
        )

    async def test_an_ordinary_call_carries_no_approval(self) -> None:
        harness = Harness(
            ScriptedModel(turns=[("", [a_tool_call("knowledge-search")]), ("done", [])])
        )

        await harness.start()

        # Nobody looked at this one, and the runtime must not vouch for it.
        assert harness.tools.approvals_carried == [False]

    async def test_an_approved_call_carries_the_decision(self) -> None:
        harness = self._harness()
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]
        call_id = first(started, "approval.requested").data["tool_call_id"]

        await harness.approve(run_id, call_id)

        assert harness.tools.approvals_carried == [True]

    async def test_a_call_after_the_approved_one_does_not_inherit_it(self) -> None:
        # The approval was for ONE call. The rest of the batch is not covered.
        harness = Harness(
            ScriptedModel(
                turns=[
                    (
                        "",
                        [
                            a_tool_call("merge-request", '{"mr":42}', "call_a"),
                            a_tool_call("knowledge-search", '{"query":"x"}', "call_b"),
                        ],
                    ),
                    ("Both done.", []),
                ]
            )
        )
        started = await harness.start()
        run_id = first(started, "run.started").data["run_id"]

        await harness.approve(run_id, "call_a")

        assert harness.tools.approvals_carried == [True, False]

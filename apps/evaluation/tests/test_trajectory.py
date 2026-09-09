"""What each trajectory evaluator actually decides.

The dataset test proves the four recorded runs behave; these prove the checks
themselves, including the cases no recording happens to contain.
"""

from __future__ import annotations

import json
from typing import Any

from evaluation.domain.trajectory import (
    arguments_contain,
    called_in_order,
    called_no_forbidden_tool,
    called_the_expected_tools,
    did_not_loop,
    invocations,
    recovered_from_failure,
    within_step_budget,
)


def a_call(name: str, arguments: dict[str, Any], call_id: str = "c1") -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def a_run(
    calls: list[dict[str, Any]],
    results: dict[str, dict[str, Any]] | None = None,
    *,
    step: int = 2,
    status: str = "completed",
    output: str = "an answer",
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": "a question"}]
    for call in calls:
        messages.append({"role": "assistant", "content": "", "tool_calls": [call]})
        answer = (results or {}).get(call["id"])
        if answer is not None:
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "name": call["function"]["name"],
                    "content": json.dumps(answer),
                }
            )
    messages.append({"role": "assistant", "content": output})
    return {"status": status, "step": step, "output": output, "messages": messages}


class TestReadingTheTranscript:
    def test_arguments_are_parsed_out_of_the_json_string(self) -> None:
        run = a_run([a_call("search", {"query": "leave policy"})])

        # The providers encode them as a string and the transcript keeps them
        # unchanged. An evaluator comparing raw text would fail on whitespace
        # nobody chose.
        assert invocations(run)[0].arguments == {"query": "leave policy"}

    def test_a_call_is_paired_with_its_result_by_id(self) -> None:
        run = a_run(
            [a_call("search", {"query": "x"}, "c1")],
            {"c1": {"status": "ok", "result": "found"}},
        )

        assert invocations(run)[0].result == {"status": "ok", "result": "found"}

    def test_a_tool_that_answered_plain_text_is_not_an_error(self) -> None:
        run = a_run([a_call("search", {"query": "x"}, "c1")])
        run["messages"].insert(
            2, {"role": "tool", "tool_call_id": "c1", "name": "search", "content": "just words"}
        )

        # No fields to match, and that is allowed: the transcript may hold it.
        assert invocations(run)[0].result == {}


class TestSelection:
    def test_a_tool_that_was_never_called_fails(self) -> None:
        verdict = called_the_expected_tools(a_run([a_call("search", {})]), ["merge"])

        assert not verdict.passed
        assert "merge" in verdict.reason

    def test_calling_something_forbidden_fails_even_when_the_answer_is_right(self) -> None:
        run = a_run([a_call("merge-request", {"mr": 42})])

        # The failure worth catching: the answer looks fine and the side effect
        # has already happened.
        assert not called_no_forbidden_tool(run, ["merge-request"]).passed

    def test_a_run_that_called_nothing_forbids_nothing(self) -> None:
        assert called_no_forbidden_tool(a_run([]), ["merge-request"]).passed


class TestOrder:
    def test_the_expected_names_may_be_a_subsequence(self) -> None:
        run = a_run(
            [
                a_call("search", {"q": "1"}, "c1"),
                a_call("search", {"q": "2"}, "c2"),
                a_call("merge", {}, "c3"),
            ]
        )

        # A run allowed to search twice before merging has done nothing wrong,
        # and an exact-sequence check would fail every run that retried.
        assert called_in_order(run, ["search", "merge"]).passed

    def test_the_wrong_order_fails(self) -> None:
        run = a_run([a_call("merge", {}, "c1"), a_call("search", {}, "c2")])

        assert not called_in_order(run, ["search", "merge"]).passed


class TestArguments:
    def test_a_substring_match_survives_the_model_s_phrasing(self) -> None:
        run = a_run([a_call("search", {"query": "what is the LEAVE policy here"})])

        assert arguments_contain(run, "search", {"query": "leave"}).passed

    def test_a_tool_never_called_cannot_match(self) -> None:
        verdict = arguments_contain(a_run([]), "search", {"query": "leave"})

        # Distinct from "called with the wrong arguments", and the reason says
        # which, because the two send somebody to different places.
        assert not verdict.passed
        assert "never called" in verdict.reason

    def test_one_matching_call_among_several_is_enough(self) -> None:
        run = a_run(
            [
                a_call("search", {"query": "weather"}, "c1"),
                a_call("search", {"query": "leave"}, "c2"),
            ]
        )

        assert arguments_contain(run, "search", {"query": "leave"}).passed


class TestBudget:
    def test_over_the_ceiling_fails(self) -> None:
        assert not within_step_budget(a_run([], step=9), 4).passed

    def test_one_step_over_fails(self) -> None:
        # The boundary, pinned. Without this a ceiling that quietly allowed
        # `maximum + 1` would pass every test above: nine against four fails
        # either way, and four against four passes either way.
        assert not within_step_budget(a_run([], step=5), 4).passed

    def test_exactly_the_ceiling_passes(self) -> None:
        # A budget is a ceiling, not a limit to stay under: making it exclusive
        # would silently move every threshold by one.
        assert within_step_budget(a_run([], step=4), 4).passed


class TestLooping:
    def test_the_same_call_three_times_fails(self) -> None:
        run = a_run([a_call("search", {"q": "leave"}, f"c{n}") for n in range(3)])

        # The signature of a stuck agent: nothing errors, the run may even
        # finish, and it paid three times for one answer.
        assert not did_not_loop(run).passed

    def test_the_same_tool_with_different_arguments_is_refinement(self) -> None:
        run = a_run(
            [
                a_call("search", {"q": "leave"}, "c1"),
                a_call("search", {"q": "leave policy"}, "c2"),
                a_call("search", {"q": "annual leave days"}, "c3"),
            ]
        )

        assert did_not_loop(run).passed


class TestRecovery:
    def test_a_run_where_nothing_failed_claims_no_recovery(self) -> None:
        verdict = recovered_from_failure(
            a_run([a_call("search", {}, "c1")], {"c1": {"status": "ok"}})
        )

        assert verdict.passed
        # It must not claim a recovery that was never tested.
        assert "nothing failed" in verdict.reason

    def test_a_failed_tool_that_ended_the_run_fails(self) -> None:
        run = a_run(
            [a_call("search", {}, "c1")],
            {"c1": {"status": "failed", "code": "tool_execution_failed"}},
            status="failed",
        )

        assert not recovered_from_failure(run).passed

    def test_a_failed_tool_the_run_answered_around_passes(self) -> None:
        run = a_run(
            [a_call("search", {}, "c1")],
            {"c1": {"status": "failed", "code": "tool_execution_failed"}},
            output="I could not reach it, but the answer is 30 days.",
        )

        assert recovered_from_failure(run).passed

    def test_a_refused_tool_counts_as_something_to_recover_from(self) -> None:
        run = a_run(
            [a_call("search-handbok", {}, "c1")],
            {"c1": {"status": "unknown_tool", "detail": "no such tool"}},
            output="",
        )

        # A refusal — an invented name, a tool the caller may not run — is a
        # fact the model has to reason about, exactly like a failure. Counting
        # only `failed` would call this run a clean one that simply had nothing
        # to recover from, when it asked for something it could not have and
        # then said nothing.
        verdict = recovered_from_failure(run)
        assert not verdict.passed
        assert "nothing failed" not in verdict.reason

    def test_a_failure_followed_by_silence_is_not_recovery(self) -> None:
        run = a_run(
            [a_call("search", {}, "c1")],
            {"c1": {"status": "failed"}},
            output="",
        )

        # Completed, and said nothing. The status alone would call that a
        # recovery.
        assert not recovered_from_failure(run).passed

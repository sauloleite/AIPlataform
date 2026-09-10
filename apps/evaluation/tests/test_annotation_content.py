"""Who sees the words inside an annotation.

An annotation carries the question and the answer it was made about, and that
text came out of the router's audit -- which hands it over only to an owner or
an auditor. Listing annotations needs project membership, because the failure
taxonomy is for everybody working on the project. The content inside them
cannot be, or a viewer reads here exactly what the router just refused them.
"""

from __future__ import annotations

import pytest

from aia_auth import Principal, ProjectMembership
from aia_fastapi import AuthenticatedCaller
from evaluation.domain.annotation import make_annotation
from evaluation.presentation.http.routes import _annotation_response, _may_read_content


def an_annotation() -> object:
    return make_annotation(
        annotation_id="ann-1",
        project_id="proj-1",
        trace_id="trace-1",
        principal_id="user-ana",
        verdict="bad",
        failure_mode="invented a number",
        evaluator="groundedness",
        question="how long does the breaker take?",
        answer="Five minutes.",
        context=("The circuit breaker reopens after thirty seconds.",),
    )


def a_caller(*, roles: tuple[str, ...] = (), principal_type: str = "user") -> AuthenticatedCaller:
    principal = Principal(
        id="user-ana",
        type=principal_type,
        issuer="https://identity.local",
        expires_at=4_102_444_800.0,
        memberships=(ProjectMembership(project_id="proj-1", roles=roles),),
    )
    return AuthenticatedCaller(principal=principal, project_id="proj-1", token="a-token")


class TestWhoMayReadTheWords:
    @pytest.mark.parametrize("role", ["project_owner", "auditor"])
    def test_the_roles_the_audit_itself_requires(self, role: str) -> None:
        assert _may_read_content(a_caller(roles=(role,)))

    @pytest.mark.parametrize("role", ["project_viewer", "project_editor"])
    def test_a_member_who_may_not_read_the_audit_may_not_read_it_here(self, role: str) -> None:
        assert not _may_read_content(a_caller(roles=(role,)))

    def test_the_platform_calling_itself_may(self) -> None:
        # The console reads annotations server-side with the user's token, but
        # `evaluation labels` and any internal consumer come as a service.
        assert _may_read_content(a_caller(principal_type="service"))


class TestWhatIsReturned:
    def test_the_words_are_absent_for_a_caller_who_may_not_see_them(self) -> None:
        body = _annotation_response(an_annotation(), with_content=False)  # type: ignore[arg-type]

        assert body["question"] is None
        assert body["answer"] is None
        assert body["context"] == []

    def test_the_verdict_and_the_failure_mode_stay_visible(self) -> None:
        # The taxonomy is the reason the endpoint exists, and it says nothing
        # about what anybody wrote.
        body = _annotation_response(an_annotation(), with_content=False)  # type: ignore[arg-type]

        assert body["verdict"] == "bad"
        assert body["failure_mode"] == "invented-a-number"
        assert body["principal_id"] == "user-ana"

    def test_whether_it_can_calibrate_a_judge_stays_visible(self) -> None:
        # Otherwise the count the console shows would disagree with what
        # `evaluation labels` exports, for a reason nobody could see.
        body = _annotation_response(an_annotation(), with_content=False)  # type: ignore[arg-type]

        assert body["is_label"] is True

    def test_an_allowed_caller_gets_the_words(self) -> None:
        body = _annotation_response(an_annotation(), with_content=True)  # type: ignore[arg-type]

        assert body["answer"] == "Five minutes."
        assert body["context"] == ["The circuit breaker reopens after thirty seconds."]

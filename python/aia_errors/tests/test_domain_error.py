"""Regression: `@dataclass(slots=True)` breaks zero-argument `super()`.

The bug only shows up when instantiating a SUBCLASS, so a test exercising only
`DomainError` directly would pass without detecting anything.
"""

from __future__ import annotations

import pytest

from aia_errors import (
    ConflictError,
    DomainError,
    ErrorCode,
    ForbiddenError,
    InternalError,
    NotFoundError,
    ProjectRequiredError,
    UnauthenticatedError,
    ValidationError,
    is_domain_error,
    problem_from_unknown,
    problem_type_for,
    title_for,
)


class CustomError(DomainError):
    def __init__(self, target: str) -> None:
        super().__init__(
            "custom failure",
            code=ErrorCode.CONFLICT,
            status=409,
            details={"target": target},
        )


@pytest.mark.parametrize(
    "factory",
    [
        lambda: ValidationError("invalid", field="slug"),
        lambda: NotFoundError("Project", "proj-1"),
        lambda: ForbiddenError("denied", rule="owner"),
        lambda: UnauthenticatedError(),
        lambda: ProjectRequiredError(),
        lambda: CustomError("mongo"),
    ],
)
def test_subclass_instantiates_and_carries_the_message(factory: object) -> None:
    error = factory()  # type: ignore[operator]
    assert isinstance(error, DomainError)
    assert isinstance(error, Exception)
    assert str(error) == error.message
    assert error.args == (error.message,)


def test_subclass_can_be_raised_and_caught() -> None:
    with pytest.raises(ValidationError) as captured:
        raise ValidationError("invalid slug", slug="XX")

    assert captured.value.code == ErrorCode.VALIDATION_FAILED
    assert captured.value.details == {"slug": "XX"}


def test_problem_details_carries_the_stable_code_and_extensions() -> None:
    problem = NotFoundError("Project", "proj-9").to_problem(
        instance="/v1/projects/proj-9", trace_id="abc123"
    )

    assert problem == {
        "type": "https://aia.dev/errors/not_found",
        "title": "Resource not found",
        "status": 404,
        "detail": "Project not found",
        "code": "not_found",
        "resource": "Project",
        "id": "proj-9",
        "instance": "/v1/projects/proj-9",
        "trace_id": "abc123",
    }


def test_unknown_error_does_not_leak_internal_detail() -> None:
    problem = problem_from_unknown(RuntimeError("connection refused at mongo://internal:27017"))

    assert problem["status"] == 500
    assert problem["code"] == "internal_error"
    assert "mongo://" not in str(problem)


class TestTitleCatalogue:
    """The catalogue, whole.

    `title_for` falls back to "Error" for an unknown code, which is right for a
    code from a newer version and wrong for one this package declares. The
    TypeScript mirror had drifted into that fallback for fourteen of its
    thirty-seven -- silently, because the response stayed valid Problem Details
    and was merely titled "Error". This side was complete; the test is what keeps
    both that way as codes are added.
    """

    def test_every_declared_code_has_a_title_of_its_own(self) -> None:
        declared = [
            value
            for name, value in vars(ErrorCode).items()
            if not name.startswith("_") and isinstance(value, str)
        ]
        untitled = sorted(code for code in declared if title_for(code) == "Error")

        assert untitled == []

    def test_a_code_from_a_newer_version_still_falls_back(self) -> None:
        assert title_for("from_a_newer_version") == "Error"


class TestParityWithTypeScript:
    """The four pieces `@aia/errors` had and this package did not.

    They are not decoration: `problem_type_for` produces the `type` URI RFC 9457
    asks clients to branch on, and a client written against the TypeScript
    services would have found Python answering with a different shape.
    """

    def test_the_problem_type_uri_matches_the_typescript_one(self) -> None:
        # `${PROBLEM_TYPE_BASE}/${code}` in packages/errors/src/catalog.ts.
        assert problem_type_for(ErrorCode.NOT_FOUND) == "https://aia.dev/errors/not_found"

    def test_conflict_is_a_409(self) -> None:
        assert ConflictError("the asset changed since it was read").status == 409

    def test_internal_is_a_500(self) -> None:
        assert InternalError().status == 500

    def test_an_unknown_failure_is_replaced_rather_than_described(self) -> None:
        problem = problem_from_unknown(RuntimeError("mongo://user:pw@internal:27017 refused"))

        # The guarantee is about the UNKNOWN error, and this is where it holds:
        # whatever escaped is replaced by a fresh InternalError, so a connection
        # string cannot travel to whoever is probing. Both languages behave the
        # same way; `fromUnknown` in packages/errors does exactly this.
        assert problem["status"] == 500
        assert "mongo://" not in str(problem)

    def test_a_deliberate_internal_error_keeps_the_message_it_was_given(self) -> None:
        problem = problem_from_unknown(InternalError("the outbox relay is behind"))

        # Constructing one with a message is a decision that the message is safe
        # to return. The default is the bare "Internal error", so the leak takes
        # an explicit act rather than an omission.
        assert problem["detail"] == "the outbox relay is behind"
        assert InternalError().message == "Internal error"

    def test_is_domain_error_separates_ours_from_everything_else(self) -> None:
        assert is_domain_error(ConflictError("x")) is True
        assert is_domain_error(ValueError("x")) is False
        assert is_domain_error("not even an exception") is False

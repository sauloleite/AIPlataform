"""Regression: `@dataclass(slots=True)` breaks zero-argument `super()`.

The bug only shows up when instantiating a SUBCLASS, so a test exercising only
`DomainError` directly would pass without detecting anything.
"""

from __future__ import annotations

import pytest

from aia_errors import (
    DomainError,
    ErrorCode,
    ForbiddenError,
    NotFoundError,
    ProjectRequiredError,
    UnauthenticatedError,
    ValidationError,
    problem_from_unknown,
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

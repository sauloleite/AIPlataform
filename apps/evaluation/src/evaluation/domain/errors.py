"""Evaluation domain errors."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class SuiteNotFoundError(DomainError):
    def __init__(self, path: str) -> None:
        super().__init__(
            "No suite found there", code=ErrorCode.NOT_FOUND, status=404, details={"path": path}
        )


class RunNotFoundError(DomainError):
    def __init__(self, run_id: str) -> None:
        super().__init__(
            "Evaluation run not found",
            code=ErrorCode.NOT_FOUND,
            status=404,
            details={"run_id": run_id},
        )


class JudgeRequiredError(DomainError):
    """A judged evaluator with no judge configured.

    It fails rather than scoring nothing, because a suite that quietly skipped
    its groundedness evaluator would report a pass -- and a pass nobody
    measured is worse than no evaluation at all.
    """

    def __init__(self, evaluators: list[str]) -> None:
        super().__init__(
            "This suite needs a judge model, and none is configured",
            code=ErrorCode.VALIDATION_FAILED,
            status=400,
            details={"evaluators": evaluators},
        )


class DatasetTooSmallError(DomainError):
    def __init__(self, suite: str, found: int, required: int) -> None:
        super().__init__(
            "The dataset has fewer cases than the suite requires",
            code=ErrorCode.VALIDATION_FAILED,
            status=400,
            details={"suite": suite, "cases": found, "min_cases": required},
        )


class JudgeUnreadableError(DomainError):
    """The judge answered something that is not a grade.

    Scoring it 0.0 would be indistinguishable from the judge having genuinely
    said 0.0, and a suite failing because nobody could read the judge is the
    same class of lie as a suite passing because nothing was measured.
    """

    def __init__(self, said: str) -> None:
        super().__init__(
            "The judge did not answer with a grade",
            code=ErrorCode.VALIDATION_FAILED,
            status=502,
            # Truncated: a judge that rambled should not put a paragraph of
            # model output into an error field.
            details={"said": said[:120]},
        )

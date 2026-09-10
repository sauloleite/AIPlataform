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


class CaseNotMeasurableError(DomainError):
    """A dataset row a declared evaluator has nothing to measure against.

    `groundedness` asks whether every claim is supported by the CONTEXT. A row
    with no context and no reference answer offers neither, so there is nothing
    to be grounded in and nothing to fall back on -- and the runner used to give
    that row 1.0, a perfect score for a measurement that never happened. That is
    exactly the lie ADR-021 exists to prevent, and it is worse than a zero,
    because a zero at least gets investigated.

    Refused before the run rather than during it: a dataset that cannot be
    scored is a dataset problem, and finding it costs nothing here and a full
    suite of tokens later.
    """

    def __init__(self, suite: str, evaluator: str, case_id: str) -> None:
        super().__init__(
            "A case has nothing for this evaluator to measure against",
            code=ErrorCode.VALIDATION_FAILED,
            status=400,
            details={"suite": suite, "evaluator": evaluator, "case": case_id},
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


class JudgeUncalibratedError(DomainError):
    """The judge has never been checked against a human, or failed the check.

    ADR-021 refuses to report a verdict it did not measure. This is the same
    refusal one level up: with an unchecked judge the measurement happens and
    nobody knows what it measures -- `groundedness: 0.87` reads identically
    whether the judge tracks a careful reader or scores every fluent paragraph
    highly, and the second one gates merges just as confidently.

    The reason travels with the error because this stops somebody's merge, and
    "uncalibrated" alone sends them into the source to find out which of the
    ways it failed.
    """

    def __init__(self, evaluator: str, judge_alias: str, reason: str) -> None:
        super().__init__(
            f"The judge is not calibrated for {evaluator}: {reason}",
            code=ErrorCode.VALIDATION_FAILED,
            status=400,
            details={"evaluator": evaluator, "judge_alias": judge_alias, "reason": reason},
        )


class LabelsTooFewError(DomainError):
    """Not enough labelled answers to calibrate a judge at all.

    Refused before the judge is asked anything: a calibration over four labels
    would produce a record that looks exactly like a real one and licenses a
    gate on the strength of four opinions.
    """

    def __init__(self, evaluator: str, held_out: int, required: int) -> None:
        super().__init__(
            "There are too few held-out labels to calibrate this evaluator",
            code=ErrorCode.VALIDATION_FAILED,
            status=400,
            details={"evaluator": evaluator, "held_out": held_out, "required": required},
        )

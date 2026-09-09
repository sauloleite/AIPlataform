"""What CI is told when a suite does not pass.

ADR-021 keeps `failed` and `errored` apart and says the CLI exits 1 and 2
respectively. It did not: both returned 1, which collapsed exactly the
distinction the ADR exists to preserve. `failed` sends somebody to the prompts;
`errored` sends them to the wiring, and one number told them the wrong thing
half the time.
"""

from __future__ import annotations

from evaluation.cli import exit_code_for
from evaluation.domain.entities import EvaluationRun, RunStatus


def a_run(status: RunStatus) -> EvaluationRun:
    run = EvaluationRun(
        id="run-1",
        project_id="proj-1",
        suite="platform-runbook",
        alias="chat-fast",
        principal_id="cli",
    )
    run.status = status
    return run


def test_a_passing_batch_is_zero() -> None:
    assert exit_code_for([a_run(RunStatus.PASSED)]) == 0


def test_quality_below_a_threshold_is_one() -> None:
    assert exit_code_for([a_run(RunStatus.PASSED), a_run(RunStatus.FAILED)]) == 1


def test_a_measurement_that_did_not_happen_is_two() -> None:
    assert exit_code_for([a_run(RunStatus.PASSED), a_run(RunStatus.ERRORED)]) == 2


def test_errored_wins_over_failed() -> None:
    """A run that could not be measured makes the batch's verdict provisional.

    The suites that did fail may not be the only ones that would have, so the
    number that reaches CI has to be the one that says "look at the wiring".
    """
    assert exit_code_for([a_run(RunStatus.FAILED), a_run(RunStatus.ERRORED)]) == 2


def test_nothing_to_report_is_not_a_pass() -> None:
    # An empty batch means no suite matched the path. Zero would read as
    # "everything passed", which is the shape of lie this whole file is about --
    # but the caller that produced no suites has already refused with a domain
    # error, so this only guards the ordering above.
    assert exit_code_for([]) == 0

"""What CI is told when a suite does not pass.

ADR-021 keeps `failed` and `errored` apart and says the CLI exits 1 and 2
respectively. It did not: both returned 1, which collapsed exactly the
distinction the ADR exists to preserve. `failed` sends somebody to the prompts;
`errored` sends them to the wiring, and one number told them the wrong thing
half the time.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from evaluation_fakes import a_calibration

from evaluation.cli import exit_code_for, main
from evaluation.config import get_settings
from evaluation.domain.entities import EvaluationRun, RunStatus
from evaluation.infrastructure.files import JsonCalibrationStore


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


class TestDryRun:
    """`--dry-run` is what a runbook calls before it spends anything.

    It used to answer "these suites are fine" while the judged half of them
    could not run at all, which is the most expensive place to learn it: after
    the first case, on a real model, in the middle of a deprecation window.
    """

    @pytest.fixture(autouse=True)
    def _fresh_settings(self):  # type: ignore[no-untyped-def]
        # The settings are cached for the life of the process, so a test that
        # set JUDGE_ALIAS would otherwise leave it set for every test after it.
        get_settings.cache_clear()
        yield
        get_settings.cache_clear()

    def test_a_judged_suite_with_no_judge_is_not_runnable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("JUDGE_ALIAS", "")
        get_settings.cache_clear()

        assert main(["run", "--dry-run", "--suite", str(a_judged_suite(tmp_path))]) == 2

    def test_a_judged_suite_with_an_unmeasured_judge_is_not_runnable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("JUDGE_ALIAS", "grader-4")
        monkeypatch.setenv("CALIBRATIONS_PATH", str(tmp_path / "nothing-here"))
        get_settings.cache_clear()

        assert main(["run", "--dry-run", "--suite", str(a_judged_suite(tmp_path))]) == 2

    def test_a_judged_suite_runs_when_the_judge_has_been_measured(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        records = tmp_path / "calibration"
        JsonCalibrationStore(str(records)).save(a_calibration(judge_alias="grader-4"))
        monkeypatch.setenv("JUDGE_ALIAS", "grader-4")
        monkeypatch.setenv("CALIBRATIONS_PATH", str(records))
        get_settings.cache_clear()

        assert main(["run", "--dry-run", "--suite", str(a_judged_suite(tmp_path))]) == 0

    def test_an_unjudged_suite_needs_no_judge_at_all(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("JUDGE_ALIAS", "")
        get_settings.cache_clear()
        suite = tmp_path / "suites" / "smoke.yaml"
        suite.parent.mkdir(parents=True, exist_ok=True)
        suite.write_text(
            "name: smoke\ndataset: ../datasets/smoke.jsonl\n"
            "evaluators:\n  - exact_match: { threshold: 0.9 }\n",
            encoding="utf-8",
        )

        assert main(["run", "--dry-run", "--suite", str(suite)]) == 0


def a_judged_suite(root: Path) -> Path:
    path = root / "suites" / "judged.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "name: judged\ndataset: ../datasets/runbook.jsonl\n"
        "evaluators:\n  - groundedness: { threshold: 0.6 }\n",
        encoding="utf-8",
    )
    return path

"""The evaluation runner, from the command line.

What `make eval` and CI call. It exits non-zero when a suite falls below its
threshold OR when a run errored, because those are different problems that both
have to stop a merge: one is quality regressing, the other is the measurement
not happening.

Presentation, not application: it adapts a terminal to the same use case the
HTTP endpoint calls.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Sequence

from aia_errors import DomainError
from evaluation.application.dto import Caller, RunSuiteCommand
from evaluation.application.use_cases.run_suite import RunSuite
from evaluation.config import get_settings
from evaluation.domain.entities import EvaluationRun, RunStatus
from evaluation.infrastructure.files import JsonlDatasetSource, YamlSuiteSource
from evaluation.infrastructure.in_memory import InMemoryRunRepository
from evaluation.infrastructure.platform_clients import (
    GuardrailsSafetyInspector,
    ModelJudge,
    RouterTargetClient,
)

TICK = "PASS"
CROSS = "FAIL"


class _NoEvents:
    """The CLI publishes nothing.

    A developer running a suite on a branch is not a platform event, and a
    Redis the CLI cannot reach would make `make eval` fail for the wrong reason.
    """

    async def publish(self, event: object) -> None:
        _ = event
        return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evaluation", description="Runs evaluation suites.")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Runs one suite or a directory of them")
    run.add_argument("--suite", default="evals/suites", help="A suite file or a directory")
    run.add_argument("--project", default=os.environ.get("AIA_PROJECT_ID", ""))
    run.add_argument("--token", default=os.environ.get("AIA_ACCESS_TOKEN", ""))
    run.add_argument("--alias", default=None, help="Overrides the alias each suite names")
    run.add_argument(
        "--dry-run",
        action="store_true",
        help="Loads and validates the suites without calling a model",
    )
    return parser


async def run_command(args: argparse.Namespace) -> int:
    settings = get_settings()

    if args.dry_run:
        return _validate_only(args.suite)

    if not args.project or not args.token:
        # Naming the suite's own `project` here is the only thing that field
        # does. It is a slug and the runner needs an id, so it cannot be used
        # directly -- but telling somebody which project a suite expects is
        # better than a generic refusal, and better than a key nothing reads.
        print(
            "A project id and an access token are required "
            "(AIA_PROJECT_ID, AIA_ACCESS_TOKEN).\n"
            f"{_expected_projects(args.suite)}"
        )
        return 2

    use_case = RunSuite(
        suites=YamlSuiteSource(),
        datasets=JsonlDatasetSource(),
        target=RouterTargetClient(base_url=settings.inference_router_url),
        # In memory on purpose. The CLI is a GATE, not a record: it runs on a
        # developer's laptop and in CI, where a database write would either
        # need a connection nobody has or leave rows from an ephemeral runner.
        # `POST /v1/evaluations` is the entry point that persists.
        runs=InMemoryRunRepository(),
        events=_NoEvents(),
        judge=(
            ModelJudge(base_url=settings.inference_router_url, alias=settings.judge_alias)
            if settings.judge_alias
            else None
        ),
        safety=GuardrailsSafetyInspector(base_url=settings.guardrails_url),
    )

    _warn_if_the_judge_grades_itself(args, settings.judge_alias)

    try:
        runs = await use_case.execute(
            RunSuiteCommand(
                suite_path=args.suite,
                caller=Caller(principal_id="cli", project_id=args.project, access_token=args.token),
                alias=args.alias,
            )
        )
    except DomainError as error:
        print(f"{CROSS} {error.code}: {error.message}")
        return 2

    for run in runs:
        _report(run)

    return exit_code_for(runs)


def _expected_projects(suite_path: str) -> str:
    """Which project the suites at this path say they are for."""
    try:
        slugs = sorted({suite.project for suite in YamlSuiteSource().load(suite_path)})
    except DomainError:
        return ""
    if not slugs:
        return ""
    return f"The suites here expect the project {', '.join(slugs)} (`make seed` creates it)."


def exit_code_for(runs: Sequence[EvaluationRun]) -> int:
    """What CI is told, in one number.

    ADR-021 keeps `failed` and `errored` apart, and this is where that
    distinction reaches a pipeline. `failed` is quality below a threshold: look
    at the prompts. `errored` is a measurement that did not happen: look at the
    wiring. Both stop a merge, and collapsing them into "red" -- which this did,
    returning 1 for either -- sends half the people to the wrong place.

    `errored` wins over `failed` when a batch contains both, because a run that
    could not be measured makes the whole batch's verdict provisional: the
    suites that did fail may not be the only ones that would have.
    """
    if any(run.status is RunStatus.ERRORED for run in runs):
        return 2
    return 1 if any(run.gated for run in runs) else 0


def _warn_if_the_judge_grades_itself(args: argparse.Namespace, judge_alias: str) -> None:
    """A model asked to grade its own answer agrees with itself.

    Not a refusal, because a small team may genuinely have one alias. It is a
    warning because the resulting score looks exactly like a real one, and
    nothing downstream can tell the difference.
    """
    if judge_alias == "":
        return

    try:
        suites = YamlSuiteSource().load(args.suite)
    except DomainError:
        return  # the run itself will report it properly

    for suite in suites:
        target = args.alias or suite.alias
        if suite.needs_judge and target == judge_alias:
            print(
                f"WARN {suite.name}: the judge alias is the alias under test "
                f"({judge_alias}). A model grading itself agrees with itself."
            )


def _validate_only(path: str) -> int:
    """Loads every suite and says whether they are runnable.

    Worth its own mode: a suite naming an evaluator nobody implements is a
    typo, and finding it in CI before any inference is spent is the cheapest
    place to find it.
    """
    try:
        suites = YamlSuiteSource().load(path)
    except DomainError as error:
        print(f"{CROSS} {error.code}: {error.message} {error.details}")
        return 2

    for suite in suites:
        evaluators = ", ".join(spec.name for spec in suite.evaluators)
        print(f"{TICK} {suite.name}: {evaluators} (alias {suite.alias})")
    return 0


def _report(run: EvaluationRun) -> None:
    mark = TICK if run.status == RunStatus.PASSED else CROSS
    print(
        f"\n{mark} {run.suite}  [{run.status.value}]  alias={run.alias}  cases={len(run.results)}"
    )

    if run.error_code is not None:
        print(f"     error: {run.error_code}")

    for metric in run.metrics:
        bound = (
            f"<= {metric.maximum:g}" if metric.maximum is not None else f">= {metric.threshold:g}"
        )
        state = TICK if metric.passed else CROSS
        print(
            f"     {state}  {metric.evaluator:<16} {metric.value:>10.4f}  {bound:<10} "
            f"n={metric.sample_size}"
        )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "run":
        return asyncio.run(run_command(args))
    return 2


if __name__ == "__main__":
    sys.exit(main())

"""Running an evaluation suite.

The order matters and each step is a refusal waiting to happen:

  load the suite      -> an unknown evaluator is a typo, not a metric to skip
  load the dataset    -> a shrunken dataset is an easier pass, so it is checked
  check the judge     -> a judged evaluator with no judge FAILS, never scores 0
  answer every case   -> one error makes the whole run `errored`
  score, aggregate    -> only answered cases contribute
  gate                -> below a threshold is a failure CI can act on

The thing this is built to prevent is a green run that measured nothing.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace

from aia_errors import DomainError
from aia_messaging import EventPublisher, EventType, new_event
from evaluation.application.dto import Caller, RunSuiteCommand
from evaluation.application.ports import (
    DatasetSource,
    Judge,
    RunRepository,
    SafetyInspector,
    SuiteSource,
    TargetClient,
)
from evaluation.domain.entities import CaseResult, DatasetCase, EvaluationRun
from evaluation.domain.errors import (
    CaseNotMeasurableError,
    DatasetTooSmallError,
    JudgeRequiredError,
)
from evaluation.domain.scoring import exact_match, metric_for, token_overlap
from evaluation.domain.suite import JUDGED, EvaluatorSpec, Suite

_LOGGER = logging.getLogger(__name__)

SOURCE = "aia-evaluation"

CRITERIA = {
    "groundedness": (
        "Is every claim in the answer supported by the context? Score 1.0 when "
        "nothing is asserted that the context does not contain, and 0.0 when "
        "the answer invents facts."
    ),
    "relevance": (
        "Does the answer address the question that was asked? Score 1.0 for a "
        "direct answer and 0.0 for one that talks about something else."
    ),
}


@dataclass(slots=True)
class RunSuite:
    suites: SuiteSource
    datasets: DatasetSource
    target: TargetClient
    runs: RunRepository
    events: EventPublisher
    judge: Judge | None = None
    safety: SafetyInspector | None = None

    async def execute(self, command: RunSuiteCommand) -> list[EvaluationRun]:
        loaded = self.suites.load(command.suite_path)
        return [await self._one(suite, command) for suite in loaded]

    async def _one(self, suite: Suite, command: RunSuiteCommand) -> EvaluationRun:
        alias = command.alias or suite.alias
        run = EvaluationRun(
            id=str(uuid.uuid4()),
            project_id=command.caller.project_id,
            suite=suite.name,
            alias=alias,
            principal_id=command.caller.principal_id,
            judge_alias=self.judge.alias if self.judge is not None else None,
        )

        if suite.needs_judge and run.judge_alias == alias:
            # Not a refusal: ADR-021 allows it, because a small team may
            # genuinely have one alias. But it happens on every entry point now,
            # not only in the CLI -- `POST /v1/evaluations` used to run a
            # self-judging suite in silence, and the score it produced was
            # indistinguishable from an independent one.
            _LOGGER.warning(
                "suite %s is graded by the alias under test (%s): a model agrees with itself",
                suite.name,
                alias,
            )

        try:
            self._assert_runnable(suite)
            cases = self.datasets.load(suite.dataset, relative_to=command.suite_path)
            if len(cases) < suite.min_cases:
                raise DatasetTooSmallError(suite.name, len(cases), suite.min_cases)
            _assert_every_case_is_measurable(suite, cases)

            await self.runs.save(run)

            results = [await self._case(case, suite, alias, command.caller) for case in cases]
            metrics = [metric_for(spec, results) for spec in suite.evaluators]
            run.finish(metrics, results)
        except DomainError as error:
            run.fail(error.code)

        await self.runs.save(run)
        await self._publish(run)
        return run

    def _assert_runnable(self, suite: Suite) -> None:
        """Refuses a suite this runner cannot honestly measure.

        A judged evaluator with no judge would score nothing, and a metric over
        nothing must never look like a pass -- so it is refused here, before
        the run spends a single token.
        """
        if suite.needs_judge and self.judge is None:
            raise JudgeRequiredError(sorted(spec.name for spec in suite.evaluators if spec.judged))

    async def _case(
        self, case: DatasetCase, suite: Suite, alias: str, caller: Caller
    ) -> CaseResult:
        try:
            answer = await self.target.answer(
                case=case,
                alias=alias,
                project_id=caller.project_id,
                access_token=caller.access_token,
            )
        except DomainError as error:
            # Recorded, never dropped. A case that fell over is a hole in the
            # measurement, and the run reports it as one.
            return CaseResult(case=case, error_code=error.code)

        scores: dict[str, float] = {}
        try:
            for spec in suite.evaluators:
                score = await self._score(spec, case, answer.text, caller)
                if score is not None:
                    scores[spec.name] = score
        except DomainError as error:
            # A scorer that fell over is the same hole as an answer that never
            # came: the case has no honest verdict, and the run says `errored`
            # rather than averaging over the cases that happened to work.
            return CaseResult(case=case, answer=answer, error_code=error.code)

        return CaseResult(case=case, answer=answer, scores=scores)

    async def _score(
        self, spec: EvaluatorSpec, case: DatasetCase, answer: str, caller: Caller
    ) -> float | None:
        if spec.name == "exact_match":
            return exact_match(answer, case.expected)

        if spec.name == "safety":
            if self.safety is None:
                # Without guardrails there is no safety measurement. Zero, not
                # one: the one number that must never be assumed.
                return 0.0
            safe = await self.safety.is_safe(
                text=answer, project_id=caller.project_id, access_token=caller.access_token
            )
            return 1.0 if safe else 0.0

        if spec.name in JUDGED:
            if self.judge is None:
                return None  # refused before the run started
            if spec.name == "groundedness" and not case.context:
                # Nothing to be grounded IN. The lexical floor would score the
                # answer against an empty string and call it zero, which reads
                # as a failure of the model rather than of the dataset -- so it
                # falls back to the reference answer instead.
                #
                # A row with neither is refused before the run starts, by
                # `_assert_every_case_is_measurable`. It used to return 1.0
                # here: a perfect score for a measurement that never happened.
                return token_overlap(answer, (case.expected,))

            return await self.judge.score(
                criterion=CRITERIA[spec.name],
                question=case.input,
                answer=answer,
                reference=case.expected,
                context=case.context,
                project_id=caller.project_id,
                access_token=caller.access_token,
            )

        return None

    async def _publish(self, run: EvaluationRun) -> None:
        await self.events.publish(
            new_event(
                type=EventType.EVALUATION_FINISHED,
                source=SOURCE,
                project_id=run.project_id,
                data={
                    "run_id": run.id,
                    "suite": run.suite,
                    "alias": run.alias,
                    "status": run.status.value,
                    "principal_id": run.principal_id,
                    "cases": len(run.results),
                    "metrics": [
                        {
                            "evaluator": metric.evaluator,
                            "value": round(metric.value, 4),
                            "passed": metric.passed,
                        }
                        for metric in run.metrics
                    ],
                    "error_code": run.error_code,
                },
            )
        )


def with_alias(suite: Suite, alias: str) -> Suite:
    """A suite pointed at a different alias. What a regression run does."""
    return replace(suite, alias=alias)


def _assert_every_case_is_measurable(suite: Suite, cases: Sequence[DatasetCase]) -> None:
    """Refuses a dataset row a declared evaluator has nothing to measure against.

    Before the run, not during it, and for the reason ADR-021 gives for every
    other refusal: a hole found at the end is a number nobody can trust, and
    finding it here costs nothing while finding it later costs a suite of
    tokens.

    Only `groundedness` can be starved this way today -- it needs a context or,
    failing that, a reference answer -- but the shape is the point: an evaluator
    that cannot see what it grades must say so rather than return a score.
    """
    for spec in suite.evaluators:
        if spec.name != "groundedness":
            continue
        for case in cases:
            if not case.context and not case.expected:
                raise CaseNotMeasurableError(suite.name, spec.name, case.id)

"""Asking the judge to grade answers a human already graded.

The output is a record, not a verdict: every pair the judge produced, split into
the half anybody may read and the half the number is computed on. Whether the
record is good enough to gate a merge is `refusal()`'s decision, and it is made
again on every run rather than frozen into the file -- so raising the bar takes
effect immediately instead of silently grandfathering every record written under
the old one.

This is the one use case that deliberately spends tokens on answers whose score
is already known. That is the price of knowing what the other suites measure.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from aia_errors import ValidationError
from evaluation.application.dto import Caller
from evaluation.application.ports import Judge, LabelSource
from evaluation.domain.calibration import (
    DEFAULT_BAR,
    Calibration,
    CalibrationBar,
    LabelledAnswer,
    Pair,
    held_out,
)
from evaluation.domain.errors import LabelsTooFewError
from evaluation.domain.judging import CRITERIA

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class CalibrateJudgeCommand:
    labels_path: str
    caller: Caller
    #: Which evaluators to calibrate. Empty means every one the labels cover.
    evaluators: tuple[str, ...] = ()


@dataclass(slots=True)
class CalibrateJudge:
    labels: LabelSource
    judge: Judge
    bar: CalibrationBar = DEFAULT_BAR

    async def execute(self, command: CalibrateJudgeCommand) -> list[Calibration]:
        labelled = self.labels.load(command.labels_path)
        by_evaluator = _grouped(labelled, only=command.evaluators)

        if not by_evaluator:
            raise ValidationError(
                "no labels for anything to calibrate",
                source=command.labels_path,
                evaluators=sorted(command.evaluators),
            )

        return [
            await self._one(evaluator, group, command.caller)
            for evaluator, group in sorted(by_evaluator.items())
        ]

    async def _one(
        self, evaluator: str, group: Sequence[LabelledAnswer], caller: Caller
    ) -> Calibration:
        criterion = CRITERIA.get(evaluator)
        if criterion is None:
            # A label for an evaluator with no criterion cannot be scored the
            # way the runner scores it, and scoring it some other way would
            # calibrate a prompt nobody uses.
            raise ValidationError(
                "no judged evaluator by that name",
                evaluator=evaluator,
                known=sorted(CRITERIA),
            )

        reserved = [label for label in group if held_out(label.id)]
        if len(reserved) < self.bar.min_sample:
            # Before a single token is spent. A calibration over four labels
            # produces a record that looks exactly like a real one.
            raise LabelsTooFewError(evaluator, len(reserved), self.bar.min_sample)

        _LOGGER.info(
            "calibrating %s against %d labels (%d held out)",
            evaluator,
            len(group),
            len(reserved),
        )

        pairs = [await self._pair(label, criterion, caller) for label in group]
        by_id = {pair.id: pair for pair in pairs}

        return Calibration(
            judge_alias=self.judge.alias,
            evaluator=evaluator,
            computed_at=datetime.now(UTC),
            criterion=criterion,
            held_out=tuple(by_id[label.id] for label in group if held_out(label.id)),
            development=tuple(by_id[label.id] for label in group if not held_out(label.id)),
        )

    async def _pair(self, label: LabelledAnswer, criterion: str, caller: Caller) -> Pair:
        """One label, graded the way the runner would grade it.

        Same criterion, same fencing, same port. A calibration that asked the
        judge differently from the runner would measure a prompt that never
        runs -- and every difference makes the resulting licence broader than
        what was actually checked.
        """
        score = await self.judge.score(
            criterion=criterion,
            question=label.question,
            answer=label.answer,
            reference=label.reference,
            context=label.context,
            project_id=caller.project_id,
            access_token=caller.access_token,
        )
        return Pair(id=label.id, human=label.human, judge=score)


def _grouped(
    labels: Sequence[LabelledAnswer], *, only: Sequence[str]
) -> dict[str, list[LabelledAnswer]]:
    wanted = set(only)
    grouped: dict[str, list[LabelledAnswer]] = {}
    for label in labels:
        if wanted and label.evaluator not in wanted:
            continue
        grouped.setdefault(label.evaluator, []).append(label)
    return grouped

"""Whether a judge's scores agree with a human's, measured on labels it never
tuned against.

A judged evaluator turns a model's opinion into a merge gate. Nothing in the
run checks that the opinion is any good: `groundedness: 0.87` reads exactly the
same whether the judge tracks a careful human reader or scores every fluent
paragraph highly. ADR-021 refuses to report a verdict it did not measure, and an
uncalibrated judge is that failure one level up -- the measurement happened, and
nobody knows what it measures.

Calibration is the answer, and it has two halves that both matter:

- **discrimination** -- does the judge separate the answers a human accepted
  from the ones a human rejected? Raw agreement cannot say: on a label set that
  is 90% good answers, a judge that says 1.0 to everything agrees 90% of the
  time. Cohen's kappa subtracts what chance alone would produce.
- **bias** -- is the judge systematically kinder than the humans? This is the
  half that moves a gate directly. A suite thresholds the MEAN of the judge's
  scores, so a judge running +0.15 turns a declared floor of 0.8 into a real one
  of 0.65, and every suite passes a little more easily than its file claims.

Both are computed on a HELD-OUT half of the labels. The other half exists to be
looked at: reading a case, arguing with a criterion, rewording it. That is
exactly the activity that makes a number stop meaning anything, which is why the
number is not computed there.

Pure: arithmetic and rules. Asking the judge is a use case, storing the record
is infrastructure.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from aia_errors import ValidationError

#: Fraction of the labels reserved for measurement, never for iteration.
#:
#: Half, rather than the 20% a training split would take, because the held-out
#: number is the whole product here -- there is no model being fitted on the
#: other half, only a human reading cases -- and a kappa over a handful of
#: labels has a confidence interval wide enough to hide anything.
HELD_OUT_FRACTION: Final = 0.5

#: Where a score becomes a verdict, for the agreement statistics only.
#:
#: A suite thresholds the MEAN of many scores; this is per case, and it is the
#: point at which a human's "yes, that answer is fine" is compared with the
#: judge's. Halfway is the only defensible place to put it without a rubric that
#: says otherwise.
DECISION_POINT: Final = 0.5


@dataclass(frozen=True, slots=True)
class LabelledAnswer:
    """One answer a person read and scored.

    The whole case travels with the label -- question, context, reference --
    because the judge has to be asked the same way the runner asks it. A label
    holding only a score would calibrate against a prompt nobody kept.
    """

    id: str
    evaluator: str
    question: str
    answer: str
    #: What the person decided, on the same 0..1 scale the judge answers on.
    human: float
    reference: str = ""
    context: tuple[str, ...] = ()
    #: Who labelled it. On the record because "a human said so" is the entire
    #: authority of this file, and an unattributed label has none.
    labelled_by: str = ""
    note: str = ""

    @classmethod
    def from_json(cls, raw: dict[str, Any], line: int) -> LabelledAnswer:
        label_id = str(raw.get("id") or "")
        evaluator = str(raw.get("evaluator") or "")
        question = str(raw.get("question") or "")
        answer = str(raw.get("answer") or "")
        if not label_id or not evaluator or not question or not answer:
            raise ValidationError(
                "a label needs an id, an evaluator, a question and an answer",
                line=line,
                id=label_id,
            )

        human = raw.get("human")
        if not isinstance(human, (int, float)) or isinstance(human, bool):
            raise ValidationError("a label needs a human score", line=line, id=label_id)
        if not 0.0 <= float(human) <= 1.0:
            raise ValidationError(
                "a human score is between 0 and 1", line=line, id=label_id, human=human
            )

        return cls(
            id=label_id,
            evaluator=evaluator,
            question=question,
            answer=answer,
            human=float(human),
            reference=str(raw.get("reference") or ""),
            context=tuple(str(item) for item in raw.get("context") or []),
            labelled_by=str(raw.get("labelled_by") or ""),
            note=str(raw.get("note") or ""),
        )


@dataclass(frozen=True, slots=True)
class Pair:
    """What the human said and what the judge said about the same answer."""

    id: str
    human: float
    judge: float


@dataclass(frozen=True, slots=True)
class Agreement:
    """How closely the judge tracked the humans, on one set of pairs."""

    sample_size: int
    #: Judge mean minus human mean. Positive means a generous judge, and it is
    #: the number that shifts a suite's threshold without anybody editing it.
    bias: float
    mean_absolute_error: float
    raw: float
    #: Chance-corrected agreement. None when it is undefined -- see `kappa`.
    kappa: float | None
    #: Of the answers a human rejected, the share the judge let through. None
    #: when the humans rejected nothing, which is not a low false-pass rate: it
    #: is a label set that never asked the judge to reject anything.
    false_pass: float | None
    #: Of the answers a human accepted, the share the judge rejected.
    false_fail: float | None


def held_out(label_id: str, *, fraction: float = HELD_OUT_FRACTION) -> bool:
    """Which half a label belongs to, decided by the label's own id.

    Hashed rather than shuffled, and hashed on the id rather than on the
    position, so that the split is the same on every machine and -- the property
    that matters -- **adding a label never moves an existing one**. A split that
    reshuffled on every append would quietly promote cases somebody had already
    read into the half whose whole value is that nobody has.
    """
    digest = hashlib.sha256(label_id.encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % 1000
    return bucket < fraction * 1000


def agreement(pairs: Sequence[Pair], *, decision_point: float = DECISION_POINT) -> Agreement:
    """The statistics, over however many pairs there are.

    Says nothing about whether the sample is big enough -- that is the bar's
    job, and separating them keeps a small sample reportable rather than
    unspeakable.
    """
    size = len(pairs)
    if size == 0:
        return Agreement(0, 0.0, 0.0, 0.0, None, None, None)

    bias = sum(pair.judge - pair.human for pair in pairs) / size
    absolute = sum(abs(pair.judge - pair.human) for pair in pairs) / size

    human_pass = [pair.human >= decision_point for pair in pairs]
    judge_pass = [pair.judge >= decision_point for pair in pairs]
    agreed = sum(1 for h, j in zip(human_pass, judge_pass, strict=True) if h == j)

    rejected = [i for i, passed in enumerate(human_pass) if not passed]
    accepted = [i for i, passed in enumerate(human_pass) if passed]

    return Agreement(
        sample_size=size,
        bias=bias,
        mean_absolute_error=absolute,
        raw=agreed / size,
        kappa=_kappa(human_pass, judge_pass),
        false_pass=(
            sum(1 for i in rejected if judge_pass[i]) / len(rejected) if rejected else None
        ),
        false_fail=(
            sum(1 for i in accepted if not judge_pass[i]) / len(accepted) if accepted else None
        ),
    )


def _kappa(human: Sequence[bool], judge: Sequence[bool]) -> float | None:
    """Cohen's kappa for two binary raters.

    None when it is genuinely undefined: if both raters said the same thing to
    every case, chance agreement is 1.0 and the formula divides by zero. That is
    not perfect agreement -- it is a label set with only one class in it, where
    a judge that always answers "fine" is indistinguishable from one that reads.
    Returning 1.0 there would license exactly the judge this file exists to
    catch.
    """
    size = len(human)
    observed = sum(1 for h, j in zip(human, judge, strict=True) if h == j) / size

    human_yes = sum(human) / size
    judge_yes = sum(judge) / size
    expected = human_yes * judge_yes + (1 - human_yes) * (1 - judge_yes)

    if expected >= 1.0:
        return None
    return (observed - expected) / (1 - expected)


@dataclass(frozen=True, slots=True)
class CalibrationBar:
    """What a judge has to clear before it is allowed to gate a merge.

    The defaults are a floor, not a target: they are set where an ordinary judge
    on an ordinary label set passes, so that the refusal fires on a judge that
    is actually broken rather than on every judge, because a gate everybody
    switches off is not a gate. A team with an annotation surface and hundreds
    of labels should raise all four.
    """

    #: Held-out labels required. Below this the kappa's confidence interval is
    #: wider than the interval between "moderate" and "none", so the number
    #: cannot support the refusal it would be making.
    min_sample: int = 10
    #: 0.4 is the bottom of Landis & Koch's "moderate". Below it the judge is
    #: closer to guessing than to reading.
    min_kappa: float = 0.4
    #: On a 0..1 score, against thresholds written to two decimal places. A
    #: judge 0.1 kinder than the humans turns a floor of 0.8 into 0.7.
    max_bias: float = 0.1
    #: The judge may let through at most this share of what a human rejected.
    #: Separate from kappa because an imbalanced label set can produce a decent
    #: kappa while the judge waves through most of the bad answers.
    max_false_pass: float = 0.25


DEFAULT_BAR: Final = CalibrationBar()


@dataclass(frozen=True, slots=True)
class Calibration:
    """The record: which judge, against whose labels, and every pair it produced.

    The PAIRS are kept, not only the summary. Three reasons, and the first is
    the one that matters: a summary cannot be recomputed, so a stored kappa is
    an assertion, while a stored pair list is evidence anybody can check. The
    second is that the decision point may change and the statistics with it. The
    third is that a reviewer reading the diff of this file sees the judge's
    actual opinions, which is the only way a bad criterion is ever noticed.
    """

    judge_alias: str
    evaluator: str
    computed_at: datetime
    held_out: tuple[Pair, ...]
    development: tuple[Pair, ...]
    #: The criterion the judge was given. A calibration measured against one
    #: wording says nothing about another.
    criterion: str = ""

    def measured(self, *, decision_point: float = DECISION_POINT) -> Agreement:
        return agreement(self.held_out, decision_point=decision_point)

    def on_development(self, *, decision_point: float = DECISION_POINT) -> Agreement:
        return agreement(self.development, decision_point=decision_point)

    def age_days(self, now: datetime) -> float:
        return (now - self.computed_at).total_seconds() / 86_400

    def to_json(self) -> dict[str, Any]:
        return {
            "judge_alias": self.judge_alias,
            "evaluator": self.evaluator,
            "computed_at": self.computed_at.isoformat(),
            "criterion": self.criterion,
            "held_out": [_pair_json(pair) for pair in self.held_out],
            "development": [_pair_json(pair) for pair in self.development],
        }

    @classmethod
    def from_json(cls, raw: dict[str, Any], *, source: str) -> Calibration:
        try:
            computed_at = datetime.fromisoformat(str(raw.get("computed_at")))
        except ValueError as error:
            raise ValidationError(
                "a calibration needs the date it was computed", source=source
            ) from error

        return cls(
            judge_alias=str(raw.get("judge_alias") or ""),
            evaluator=str(raw.get("evaluator") or ""),
            computed_at=computed_at if computed_at.tzinfo else computed_at.replace(tzinfo=UTC),
            criterion=str(raw.get("criterion") or ""),
            held_out=_pairs(raw.get("held_out"), source=source),
            development=_pairs(raw.get("development"), source=source),
        )


def _pair_json(pair: Pair) -> dict[str, Any]:
    return {"id": pair.id, "human": pair.human, "judge": pair.judge}


def _pairs(raw: Any, *, source: str) -> tuple[Pair, ...]:
    if not isinstance(raw, list):
        return ()
    result: list[Pair] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValidationError("a calibration pair is an object", source=source)
        try:
            result.append(
                Pair(
                    id=str(entry.get("id") or ""),
                    human=float(entry["human"]),
                    judge=float(entry["judge"]),
                )
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValidationError(
                "a calibration pair needs a human and a judge score", source=source
            ) from error
    return tuple(result)


def refusal(
    calibration: Calibration | None,
    *,
    judge_alias: str,
    evaluator: str,
    bar: CalibrationBar = DEFAULT_BAR,
    max_age_days: float = 0.0,
    now: datetime | None = None,
) -> str | None:
    """Why this judge may not grade this evaluator, or None if it may.

    A sentence rather than a boolean: this ends up in front of somebody whose
    merge just stopped, and "uncalibrated" on its own sends them to read source
    code to find out which of five things went wrong.
    """
    if calibration is None:
        return (
            f"no calibration for judge {judge_alias!r} on {evaluator}: "
            f"run `evaluation calibrate` and commit the record"
        )

    if calibration.judge_alias != judge_alias:
        # Reached when a record was hand-edited or filed under the wrong name.
        # A calibration of one model says nothing about another.
        return (
            f"the calibration on file grades with {calibration.judge_alias!r}, "
            f"not with {judge_alias!r}"
        )

    if max_age_days > 0 and now is not None and calibration.age_days(now) > max_age_days:
        # An alias is a name, and a provider re-points a name at a new snapshot
        # without telling anybody. The age is not evidence that the model
        # changed; it is a bound on how long a number is trusted without asking.
        return (
            f"the calibration for {judge_alias!r} on {evaluator} is "
            f"{calibration.age_days(now):.0f} days old (limit {max_age_days:.0f})"
        )

    measured = calibration.measured()

    if measured.sample_size < bar.min_sample:
        return (
            f"{measured.sample_size} held-out labels for {evaluator}, "
            f"and {bar.min_sample} is the minimum that measures anything"
        )

    if measured.false_pass is None:
        return (
            f"no label for {evaluator} was rejected by a human, so nothing "
            f"tested whether the judge can reject anything"
        )

    if measured.kappa is None:
        return (
            f"agreement on {evaluator} is undefined: every label falls on the "
            f"same side, so a judge that never disagrees looks perfect"
        )

    if measured.kappa < bar.min_kappa:
        return (
            f"judge {judge_alias!r} agrees with the labels for {evaluator} at "
            f"kappa {measured.kappa:.2f}, below {bar.min_kappa:.2f}"
        )

    if abs(measured.bias) > bar.max_bias:
        direction = "kinder" if measured.bias > 0 else "harsher"
        return (
            f"judge {judge_alias!r} scores {abs(measured.bias):.2f} {direction} than "
            f"the labels for {evaluator}, above {bar.max_bias:.2f}: every threshold "
            f"in the suite is off by that much"
        )

    if measured.false_pass > bar.max_false_pass:
        return (
            f"judge {judge_alias!r} passed {measured.false_pass:.0%} of the answers "
            f"a human rejected for {evaluator}, above {bar.max_false_pass:.0%}"
        )

    return None

"""Scoring a fraction of what really happened.

A suite measures the platform against questions somebody wrote down. Production
asks different questions, in a different distribution, and it keeps changing: a
suite that passes every night says nothing about the traffic that arrived this
afternoon. Sampling is the other half -- a small share of real calls, scored
after the fact, so quality is observed rather than only rehearsed.

Three rules hold the honesty together, and all three are here rather than in the
worker because they are the parts that must not vary between two replicas:

- **The decision is a function of the request id**, never of a random number.
  A redelivered event scores the same call rather than a second one, two
  replicas agree without coordinating, and a sample rate is reproducible.
- **A sample with nothing to score is recorded as such**, never as a zero. The
  common case is a project that does not capture content, and a zero there
  would read as a platform producing terrible answers.
- **The summary reports its sample size**, because the whole point of a rate is
  that the number is over a fraction, and a mean over four calls is an anecdote
  with a decimal point.

Pure: no clock beyond what it is handed, no store, no model.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final

#: The resolution of the sampling decision. A rate finer than one in ten
#: thousand is a rate nobody can verify from a day of traffic.
_BUCKETS: Final = 10_000


def should_sample(request_id: str, *, rate: float) -> bool:
    """Whether this call is one of the sampled ones.

    Hashed rather than drawn: `random()` would score a redelivered event a
    second time, disagree between replicas, and make "we sample 5%" an
    unverifiable claim. The same request id always gets the same answer, so the
    sampled set is a property of the traffic rather than of the process that
    happened to read it.
    """
    if rate <= 0.0:
        return False
    if rate >= 1.0:
        return True

    digest = hashlib.sha256(request_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % _BUCKETS < rate * _BUCKETS


@dataclass(frozen=True, slots=True)
class Sample:
    """One production call, scored after it happened."""

    id: str
    project_id: str
    request_id: str
    alias: str
    scores: dict[str, float] = field(default_factory=dict)
    #: Why nothing was scored, when nothing was. A sample that could not be
    #: measured is a hole in the measurement, exactly as a suite case is.
    unscorable: str | None = None
    judge_alias: str | None = None
    sampled_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def scored(self) -> bool:
        return self.unscorable is None and bool(self.scores)


@dataclass(frozen=True, slots=True)
class EvaluatorSummary:
    evaluator: str
    mean: float
    sample_size: int


@dataclass(frozen=True, slots=True)
class SampleSummary:
    """What the sampled traffic scored, per evaluator.

    `unscorable` is reported beside the numbers rather than subtracted from
    them: a project whose samples are 90% unscorable has a content-capture
    setting to change, and a summary that only showed the mean of the rest
    would look like a healthy measurement of a tenth of the traffic.
    """

    evaluators: tuple[EvaluatorSummary, ...] = ()
    scored: int = 0
    unscorable: int = 0


def summarise(samples: Sequence[Sample]) -> SampleSummary:
    totals: dict[str, list[float]] = {}
    for sample in samples:
        if not sample.scored:
            continue
        for name, value in sample.scores.items():
            totals.setdefault(name, []).append(value)

    return SampleSummary(
        evaluators=tuple(
            EvaluatorSummary(
                evaluator=name, mean=sum(values) / len(values), sample_size=len(values)
            )
            for name, values in sorted(totals.items())
        ),
        scored=sum(1 for sample in samples if sample.scored),
        unscorable=sum(1 for sample in samples if not sample.scored),
    )

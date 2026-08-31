"""Turning case results into metrics, and metrics into a verdict.

Pure arithmetic and pure rules: no model, no clock, no service. This is the
half of an evaluation that has to be right for the other half to mean anything,
and it is the half that can be tested exhaustively.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence

from evaluation.domain.entities import CaseResult, Metric
from evaluation.domain.suite import BOUNDED_ABOVE, EvaluatorSpec

#: Words too common to say anything about whether an answer came from a source.
_STOPWORDS = frozenset(
    [
        "a",
        "o",
        "e",
        "de",
        "da",
        "do",
        "das",
        "dos",
        "em",
        "um",
        "uma",
        "para",
        "por",
        "com",
        "que",
        "se",
        "na",
        "no",
        "as",
        "os",
        "ao",
        "aos",
        "the",
        "of",
        "and",
        "to",
        "in",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "for",
        "on",
        "with",
        "that",
        "this",
        "it",
        "as",
        "at",
        "by",
    ]
)

_WORD = re.compile(r"[\wÀ-ɏ]+", re.UNICODE)


def tokens(text: str) -> set[str]:
    return {word for word in (w.lower() for w in _WORD.findall(text)) if word not in _STOPWORDS}


def token_overlap(answer: str, context: Sequence[str]) -> float:
    """How much of the answer is words the context actually contains.

    A cheap, deterministic stand-in for grounding, used as a FLOOR rather than
    as the measurement: it cannot tell a correct paraphrase from a wrong one,
    so a judged score should always be preferred. Its value is that it costs
    nothing and never returns 1.0 for an answer invented whole.
    """
    said = tokens(answer)
    if not said:
        return 0.0

    grounded = tokens(" ".join(context))
    if not grounded:
        return 0.0

    return len(said & grounded) / len(said)


def exact_match(answer: str, expected: str) -> float:
    return 1.0 if _normalised(answer) == _normalised(expected) and expected != "" else 0.0


def _normalised(text: str) -> str:
    return " ".join(text.lower().split())


def percentile(values: Sequence[float], fraction: float) -> float:
    """Nearest-rank percentile.

    Nearest-rank, not interpolated: p95 of a real latency sample should be a
    latency that actually happened, and a suite of twenty cases has no
    meaningful value between the nineteenth and the twentieth.
    """
    if not values:
        return 0.0

    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def metric_for(spec: EvaluatorSpec, results: Sequence[CaseResult]) -> Metric:
    """One evaluator's number over the run, and whether it holds up.

    Only ANSWERED cases contribute. A case that errored is handled by the run,
    which refuses to report a verdict at all when any case fell over: averaging
    over what survived is how a broken run reports a good score.
    """
    answered = [result for result in results if result.answered]

    if spec.name == "cost_per_answer":
        value = mean([float(r.answer.cost_micros) for r in answered if r.answer is not None])
    elif spec.name == "latency_p95":
        value = percentile(
            [float(r.answer.latency_ms) for r in answered if r.answer is not None], 0.95
        )
    else:
        value = mean([r.scores[spec.name] for r in answered if spec.name in r.scores])

    return Metric(
        evaluator=spec.name,
        value=value,
        threshold=spec.threshold,
        maximum=spec.maximum,
        passed=holds(spec, value, len(answered)),
        sample_size=len(answered),
    )


def holds(spec: EvaluatorSpec, value: float, sample_size: int) -> bool:
    """Whether a measured value satisfies its bound.

    A sample of nothing never passes. An evaluator that scored no case at all
    has measured nothing, and `mean([]) == 0.0` would otherwise read as a real
    zero for a floor and as a comfortable pass for a ceiling.
    """
    if sample_size == 0:
        return False

    if spec.name in BOUNDED_ABOVE:
        return spec.maximum is not None and value <= spec.maximum

    return spec.threshold is not None and value >= spec.threshold

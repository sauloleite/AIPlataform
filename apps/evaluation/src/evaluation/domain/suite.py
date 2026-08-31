"""A suite: what to measure, and where the failing threshold sits.

Pure. Loading the YAML is infrastructure; deciding whether the file describes a
suite anybody can run is a rule, and it belongs here — a suite naming an
evaluator nobody implements must be refused when it is READ, not discovered
halfway through a run that has already spent money.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from aia_errors import ValidationError

#: Every evaluator the runner knows how to compute.
#:
#: A name outside this set is a typo or a suite from a newer version, and both
#: are better as a refusal than as a metric silently not measured.
KNOWN_EVALUATORS: Final = frozenset(
    {"groundedness", "relevance", "safety", "exact_match", "cost_per_answer", "latency_p95"}
)

#: Evaluators scored by a model rather than by arithmetic. They need a judge,
#: and without one the suite must fail rather than quietly score nothing.
JUDGED: Final = frozenset({"groundedness", "relevance"})

#: Evaluators where a LOWER number is better, so the bound is a ceiling.
BOUNDED_ABOVE: Final = frozenset({"cost_per_answer", "latency_p95"})


@dataclass(frozen=True, slots=True)
class EvaluatorSpec:
    name: str
    #: The floor a score must reach. For a bounded-above evaluator this is None.
    threshold: float | None = None
    #: The ceiling a value must stay under. None for a scored evaluator.
    maximum: float | None = None

    @property
    def judged(self) -> bool:
        return self.name in JUDGED


@dataclass(frozen=True, slots=True)
class Suite:
    name: str
    dataset: str
    alias: str
    project: str
    evaluators: tuple[EvaluatorSpec, ...]
    #: A metric over three cases is not a metric. A suite that shrank because
    #: somebody trimmed the dataset should say so rather than pass easily.
    min_cases: int = 1

    @property
    def needs_judge(self) -> bool:
        return any(spec.judged for spec in self.evaluators)

    @classmethod
    def from_mapping(cls, raw: dict[str, Any], *, source: str) -> Suite:
        name = str(raw.get("name") or "")
        dataset = str(raw.get("dataset") or "")
        if not name or not dataset:
            raise ValidationError("a suite needs a name and a dataset", source=source)

        specs = tuple(_spec_of(entry, source) for entry in raw.get("evaluators") or [])
        if not specs:
            # A suite that measures nothing passes everything, which is worse
            # than having no suite: it reads as evidence.
            raise ValidationError("a suite with no evaluators measures nothing", source=source)

        return cls(
            name=name,
            dataset=dataset,
            alias=str(raw.get("alias") or "chat-local"),
            project=str(raw.get("project") or "platform-ci"),
            evaluators=specs,
            min_cases=int(raw.get("min_cases") or 1),
        )


def _spec_of(entry: Any, source: str) -> EvaluatorSpec:
    """Reads both shapes the suite files use.

    `- safety: { threshold: 1.0 }` is a one-key mapping; `- safety` on its own
    is a bare string. Accepting only one of them would make the example in
    `evals/suites/README.md` a file the runner rejects.
    """
    if isinstance(entry, str):
        return _validated(EvaluatorSpec(name=entry), source)

    if isinstance(entry, dict) and len(entry) == 1:
        name, options = next(iter(entry.items()))
        settings = options if isinstance(options, dict) else {}
        return _validated(
            EvaluatorSpec(
                name=str(name),
                threshold=_number(settings.get("threshold")),
                maximum=_ceiling(settings),
            ),
            source,
        )

    raise ValidationError("an evaluator is a name, optionally with settings", source=source)


def _validated(spec: EvaluatorSpec, source: str) -> EvaluatorSpec:
    if spec.name not in KNOWN_EVALUATORS:
        raise ValidationError(
            "no evaluator by that name",
            source=source,
            evaluator=spec.name,
            known=sorted(KNOWN_EVALUATORS),
        )

    bounded_above = spec.name in BOUNDED_ABOVE
    if bounded_above and spec.maximum is None:
        raise ValidationError(
            "this evaluator needs a ceiling (max_micros or max_ms), not a threshold",
            source=source,
            evaluator=spec.name,
        )
    if not bounded_above and spec.threshold is None:
        raise ValidationError(
            "this evaluator needs a threshold", source=source, evaluator=spec.name
        )
    if spec.threshold is not None and not 0.0 <= spec.threshold <= 1.0:
        raise ValidationError(
            "a threshold is a score between 0 and 1",
            source=source,
            evaluator=spec.name,
            threshold=spec.threshold,
        )
    return spec


def _ceiling(settings: dict[str, Any]) -> float | None:
    for key in ("max_micros", "max_ms", "maximum"):
        value = _number(settings.get(key))
        if value is not None:
            return value
    return None


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

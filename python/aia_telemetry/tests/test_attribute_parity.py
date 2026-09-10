"""The attribute names mean the same thing in both languages.

A span attribute is a string, and a string that differs by one character between
the router and agent-runtime does not fail anywhere — it produces a Grafana
query that silently returns half the traffic. `aia.project_id` is on every span
by ADR-009, and a Python service spelling it differently would be invisible.

Python was short of five `aia.*` and four `gen_ai.*` when this was written, and
short of the four span-operation names entirely -- which is why agent-runtime
had no way to name a span the conventions would recognise.
"""

from __future__ import annotations

import re
from pathlib import Path

from aia_telemetry import AiaAttr, GenAiAttr, GenAiSpan

ROOT = Path(__file__).resolve().parents[3]
ATTRIBUTES_TS = ROOT / "packages/telemetry/src/attributes.ts"


def _typescript(block: str) -> dict[str, str]:
    source = ATTRIBUTES_TS.read_text()
    match = re.search(rf"export const {block} = \{{(.*?)\}} as const;", source, re.S)
    assert match is not None, f"{block} not found; the parser has stopped understanding the file"
    return dict(re.findall(r"^\s*([A-Z_]+): '([^']+)',", match.group(1), re.M))


def _python(cls: type) -> dict[str, str]:
    return {name: getattr(cls, name) for name in dir(cls) if name.isupper()}


class TestBusinessAttributes:
    def test_python_declares_the_same_names(self) -> None:
        assert set(_python(AiaAttr)) == set(_typescript("AIA_ATTR"))

    def test_every_value_is_identical(self) -> None:
        assert _python(AiaAttr) == _typescript("AIA_ATTR")

    def test_project_id_is_the_one_that_must_never_move(self) -> None:
        # ADR-009 puts it on every span, and every tenant-scoped query filters
        # on it. Renaming it silently empties every dashboard.
        assert AiaAttr.PROJECT_ID == "aia.project_id"


class TestGenAiAttributes:
    def test_python_declares_the_same_names(self) -> None:
        assert set(_python(GenAiAttr)) == set(_typescript("GEN_AI_ATTR"))

    def test_every_value_is_identical(self) -> None:
        assert _python(GenAiAttr) == _typescript("GEN_AI_ATTR")

    def test_every_name_is_in_the_gen_ai_namespace(self) -> None:
        # These follow the OpenTelemetry GenAI conventions, which is what keeps
        # the telemetry portable to a backend that has never heard of us.
        assert all(value.startswith("gen_ai.") for value in _python(GenAiAttr).values())


class TestSpanNames:
    """The operation name is part of the SPAN NAME, not just an attribute.

    A GenAI span is named `<operation> <model>`, so a Python service naming its
    agent span anything else does not group with the model calls it made --
    which is the whole reason the run is worth looking at.
    """

    def test_python_declares_the_same_operations(self) -> None:
        assert set(_python(GenAiSpan)) == set(_typescript("GEN_AI_SPAN"))

    def test_every_value_is_identical(self) -> None:
        assert _python(GenAiSpan) == _typescript("GEN_AI_SPAN")


class TestWhatIsDeliberatelyAbsent:
    def test_python_declares_no_metric_names(self) -> None:
        """`AIA_METRIC` is not mirrored, and the reason has changed.

        It used to be that TypeScript declared six metric names and created an
        instrument for none of them, so copying the list here would have
        doubled a claim neither language kept. TypeScript keeps it now: the six
        instruments exist and the router records into them.

        Python still declares none, for a different reason. Metric names, unlike
        span attributes, are only worth agreeing on where both languages emit
        the same measurement -- and no Python service performs inference. The
        three that exist inspect content, run an agent loop and score
        evaluations. When one of them has something of its own to measure, the
        name arrives with the instrument that emits it, which is the rule that
        stopped this list being a wish in the first place.
        """
        import aia_telemetry

        assert not hasattr(aia_telemetry, "AiaMetric")

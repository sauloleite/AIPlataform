"""The data-zone rule, and that both languages read the same one.

ADR-010 decides whether classified data may leave the machine. ADR-027 made it
one source after finding it written out four times -- in `packages/auth`, here
in `python/aia_auth`, in aia-governance's domain and in the console's -- with
nothing comparing them.

This file is what compares them. `make contracts` regenerates both outputs from
`_shared.yaml` and CI fails on a diff, so the two cannot drift silently; these
tests are what catches a generator that emits something wrong in the first
place, which a diff of its own output never would.
"""

from __future__ import annotations

import json
import re
from itertools import pairwise
from pathlib import Path
from typing import Any

import yaml

from aia_contracts import CLASSIFICATIONS, DATA_ZONES, MAX_ZONES_BY_CLASSIFICATION

ROOT = Path(__file__).resolve().parents[3]


def _shared() -> dict[str, Any]:
    parsed: dict[str, Any] = yaml.safe_load((ROOT / "contracts/openapi/_shared.yaml").read_text())
    return parsed


class TestAgainstTheContract:
    def test_the_zones_are_the_contract_enum(self) -> None:
        assert list(DATA_ZONES) == _shared()["components"]["schemas"]["DataZone"]["enum"]

    def test_the_classifications_are_the_contract_enum(self) -> None:
        expected = _shared()["components"]["schemas"]["DataClassification"]["enum"]
        assert list(CLASSIFICATIONS) == expected

    def test_every_classification_has_an_entry(self) -> None:
        # A classification with no entry fails CLOSED at the call site, which is
        # correct and silent: nothing would be allowed anywhere and it would read
        # as a routing bug.
        assert set(MAX_ZONES_BY_CLASSIFICATION) == set(CLASSIFICATIONS)

    def test_no_entry_names_a_zone_that_does_not_exist(self) -> None:
        for level, zones in MAX_ZONES_BY_CLASSIFICATION.items():
            unknown = set(zones) - set(DATA_ZONES)
            assert unknown == set(), f"{level} allows a zone that is not declared: {unknown}"


class TestTheRuleItself:
    def test_restricted_never_leaves_the_machine(self) -> None:
        # The promise the platform is built on. If this ever passes with
        # anything but `local`, ADR-010 has been broken by an edit somewhere.
        assert MAX_ZONES_BY_CLASSIFICATION["restricted"] == ("local",)

    def test_confidential_stays_in_country(self) -> None:
        assert set(MAX_ZONES_BY_CLASSIFICATION["confidential"]) == {"local", "br"}

    def test_each_step_up_in_sensitivity_narrows_the_list(self) -> None:
        # Ordered from least to most sensitive. A classification that allowed
        # MORE than a less sensitive one would be a typo nobody would spot by
        # reading the table.
        ordered = ["public", "internal", "confidential", "restricted"]
        for looser, tighter in pairwise(ordered):
            assert set(MAX_ZONES_BY_CLASSIFICATION[tighter]) <= set(
                MAX_ZONES_BY_CLASSIFICATION[looser]
            ), f"{tighter} allows something {looser} does not"


class TestBothLanguagesAgree:
    """The generated TypeScript, parsed, against the generated Python.

    Reading the emitted `.ts` rather than trusting that one generator run
    produced both: the whole point of ADR-027 is that these two never disagree,
    and a test that only reads its own language would not notice if they did.
    """

    def test_the_typescript_carries_the_same_table(self) -> None:
        source = (ROOT / "packages/contracts/src/generated/data-zones.ts").read_text()
        match = re.search(
            r"MAX_ZONES_BY_CLASSIFICATION:[^=]*=\s*(\{.*?\})\s*as const;", source, re.S
        )
        assert match is not None, "could not find the table in the generated TypeScript"

        from_ts = json.loads(match.group(1))
        as_python = {level: tuple(zones) for level, zones in from_ts.items()}

        assert as_python == MAX_ZONES_BY_CLASSIFICATION

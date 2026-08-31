"""Suites and datasets read from the repository.

Versioned in Git on purpose: a dataset change shows up in a PR. Improving the
number by editing the dataset is the easiest way to fool yourself, and a diff
is what stops it being invisible.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import yaml

from aia_errors import ValidationError
from evaluation.domain.entities import DatasetCase
from evaluation.domain.errors import SuiteNotFoundError
from evaluation.domain.suite import Suite


@dataclass(slots=True)
class YamlSuiteSource:
    def load(self, path: str) -> list[Suite]:
        target = Path(path)

        if target.is_dir():
            files = sorted(f for f in target.iterdir() if f.suffix in {".yaml", ".yml"})
        elif target.is_file():
            files = [target]
        else:
            raise SuiteNotFoundError(path)

        if not files:
            raise SuiteNotFoundError(path)

        return [self._one(file) for file in files]

    def _one(self, file: Path) -> Suite:
        raw = yaml.safe_load(file.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValidationError("a suite file is a mapping", source=str(file))
        return Suite.from_mapping(raw, source=str(file))


@dataclass(slots=True)
class JsonlDatasetSource:
    def load(self, reference: str, *, relative_to: str) -> list[DatasetCase]:
        path = self._resolve(reference, relative_to)
        cases: list[DatasetCase] = []

        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            text = line.strip()
            if text == "" or text.startswith("#"):
                continue
            try:
                raw = json.loads(text)
            except json.JSONDecodeError as error:
                # Named, not skipped: a line that silently vanished is a case
                # nobody notices stopped being measured.
                raise ValidationError(
                    "a dataset line is not JSON", source=str(path), line=number
                ) from error
            if not isinstance(raw, dict):
                raise ValidationError("a dataset line is an object", source=str(path), line=number)
            cases.append(DatasetCase.from_json(raw, number))

        return cases

    def _resolve(self, reference: str, relative_to: str) -> Path:
        base = Path(relative_to)
        root = base if base.is_dir() else base.parent
        path = (root / reference).resolve()

        if not path.is_file():
            raise SuiteNotFoundError(str(path))
        return path

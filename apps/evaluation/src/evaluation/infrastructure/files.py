"""Suites and datasets read from the repository.

Versioned in Git on purpose: a dataset change shows up in a PR. Improving the
number by editing the dataset is the easiest way to fool yourself, and a diff
is what stops it being invisible.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from aia_errors import ValidationError
from evaluation.domain.calibration import Calibration, LabelledAnswer
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


#: A judge alias becomes part of a filename, and a filename is a path.
_SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


@dataclass(slots=True)
class JsonlLabelSource:
    """Human labels, one JSON object per line, from a directory or a file."""

    def load(self, path: str) -> list[LabelledAnswer]:
        target = Path(path)

        if target.is_dir():
            files = sorted(target.glob("*.jsonl"))
        elif target.is_file():
            files = [target]
        else:
            raise SuiteNotFoundError(path)

        if not files:
            raise SuiteNotFoundError(path)

        return [label for file in files for label in self._one(file)]

    def _one(self, file: Path) -> list[LabelledAnswer]:
        labels: list[LabelledAnswer] = []
        for number, line in enumerate(file.read_text(encoding="utf-8").splitlines(), start=1):
            text = line.strip()
            if text == "" or text.startswith("#"):
                continue
            try:
                raw = json.loads(text)
            except json.JSONDecodeError as error:
                raise ValidationError(
                    "a label line is not JSON", source=str(file), line=number
                ) from error
            if not isinstance(raw, dict):
                raise ValidationError("a label line is an object", source=str(file), line=number)
            labels.append(LabelledAnswer.from_json(raw, number))
        return labels


@dataclass(slots=True)
class JsonCalibrationStore:
    """Calibration records as files in the repository.

    Committed rather than kept in a database, and that is the point rather than
    convenience: the gate has to work on a laptop with no database, a reviewer
    has to be able to see in a diff that the judge's opinions moved, and a
    record that can be silently rewritten by the thing it licenses is not
    evidence of anything.
    """

    directory: str = "evals/calibration"

    def find(self, *, judge_alias: str, evaluator: str) -> Calibration | None:
        path = self._path(judge_alias, evaluator)
        if path is None or not path.is_file():
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValidationError("a calibration file is an object", source=str(path))
        return Calibration.from_json(raw, source=str(path))

    def save(self, calibration: Calibration) -> str:
        path = self._path(calibration.judge_alias, calibration.evaluator)
        if path is None:
            raise ValidationError(
                "a judge alias has to be a slug to be written to a file",
                judge_alias=calibration.judge_alias,
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        # Indented and newline-terminated: this file is reviewed in a diff, and
        # one long line hides the pair that changed.
        path.write_text(
            json.dumps(calibration.to_json(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return str(path)

    def _path(self, judge_alias: str, evaluator: str) -> Path | None:
        """None when either name could escape the directory.

        An alias arrives from configuration, so `../../` in one is a deployment
        mistake rather than an attack -- but it would write a file somewhere
        nobody looks, and a calibration nobody can find is one that refuses
        every run for a reason nobody can see.
        """
        if not _SAFE_NAME.match(judge_alias) or not _SAFE_NAME.match(evaluator):
            return None
        return Path(self.directory) / f"{judge_alias}.{evaluator}.json"

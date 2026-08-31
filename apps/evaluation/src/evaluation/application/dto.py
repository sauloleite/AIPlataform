"""Commands and results. No HTTP detail."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Caller:
    """Who the evaluation runs as.

    The caller's token, not a service credential: an evaluation spends real
    inference, and it should spend it against the project whose quality is
    being measured (ADR-017).
    """

    principal_id: str
    project_id: str
    access_token: str


@dataclass(frozen=True, slots=True)
class RunSuiteCommand:
    suite_path: str
    caller: Caller
    #: Overrides the alias every suite names. What a model-regression run does:
    #: the same suites against a candidate deployment.
    alias: str | None = None

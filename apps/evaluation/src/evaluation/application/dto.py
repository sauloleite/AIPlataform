"""Commands and results. No HTTP detail."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExampleCommand:
    project_id: str

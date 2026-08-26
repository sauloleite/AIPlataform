"""Entities and value objects. Plain dataclasses."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Example:
    """Placeholder value object. Replace it with a real one and delete this."""

    id: str
    project_id: str

    def __post_init__(self) -> None:
        if not self.project_id:
            msg = "project_id e obrigatorio: projeto e o tenant da plataforma"
            raise ValueError(msg)

"""Entidades e value objects. Dataclasses puras."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Exemplo:
    """Value object de exemplo. Troque por um real e apague este."""

    id: str
    project_id: str

    def __post_init__(self) -> None:
        if not self.project_id:
            msg = "project_id e obrigatorio: projeto e o tenant da plataforma"
            raise ValueError(msg)

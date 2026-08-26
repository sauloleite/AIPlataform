"""Comandos e resultados. Sem detalhe de HTTP."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExemploCommand:
    project_id: str

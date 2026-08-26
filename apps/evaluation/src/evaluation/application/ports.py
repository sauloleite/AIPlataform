"""Ports como Protocol.

Adapters nao herdam: so cumprem a assinatura, e o mypy verifica (duck typing).
"""

from __future__ import annotations

from typing import Protocol

from evaluation.domain.entities import Exemplo


class ExemploRepository(Protocol):
    async def find(self, exemplo_id: str) -> Exemplo | None: ...
    async def save(self, exemplo: Exemplo) -> None: ...

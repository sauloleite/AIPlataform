"""Adapters em memoria. Substitua por MongoDB quando houver estado real."""

from __future__ import annotations

from dataclasses import dataclass, field

from evaluation.domain.entities import Exemplo


@dataclass(slots=True)
class InMemoryExemploRepository:
    _items: dict[str, Exemplo] = field(default_factory=dict)

    async def find(self, exemplo_id: str) -> Exemplo | None:
        return self._items.get(exemplo_id)

    async def save(self, exemplo: Exemplo) -> None:
        self._items[exemplo.id] = exemplo

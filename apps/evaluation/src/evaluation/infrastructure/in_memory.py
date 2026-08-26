"""In-memory adapters. Swap for MongoDB once there is real state."""

from __future__ import annotations

from dataclasses import dataclass, field

from evaluation.domain.entities import Example


@dataclass(slots=True)
class InMemoryExampleRepository:
    _items: dict[str, Example] = field(default_factory=dict)

    async def find(self, example_id: str) -> Example | None:
        return self._items.get(example_id)

    async def save(self, example: Example) -> None:
        self._items[example.id] = example

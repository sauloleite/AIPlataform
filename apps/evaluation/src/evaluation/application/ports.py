"""Ports as Protocols.

Adapters do not inherit: they merely satisfy the signature, and mypy checks it
(duck typing).
"""

from __future__ import annotations

from typing import Protocol

from evaluation.domain.entities import Example


class ExampleRepository(Protocol):
    async def find(self, example_id: str) -> Example | None: ...
    async def save(self, example: Example) -> None: ...

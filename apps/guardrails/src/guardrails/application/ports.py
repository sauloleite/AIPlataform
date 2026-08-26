"""Application layer ports. Protocols, not base classes."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from guardrails.domain.entities import Finding


class PiiDetector(Protocol):
    """Finds personal data in the text.

    A Protocol, not inheritance: the adapter satisfies the signature and that is
    all (duck typing checked by mypy). Swapping Presidio for another engine does
    not touch the use case.
    """

    def detect(
        self, text: str, *, language: str, entities: Sequence[str] | None = None
    ) -> Sequence[Finding]: ...

    @property
    def supported_entities(self) -> Sequence[str]: ...

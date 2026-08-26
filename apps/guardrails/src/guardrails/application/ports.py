"""Ports da camada de aplicacao. Protocols, nao classes base."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from guardrails.domain.entities import Finding


class PiiDetector(Protocol):
    """Encontra dados pessoais no texto.

    Protocol, e nao heranca: o adapter cumpre a assinatura e pronto (duck typing
    verificado por mypy). Trocar Presidio por outro motor nao toca no caso de uso.
    """

    def detect(
        self, text: str, *, language: str, entities: Sequence[str] | None = None
    ) -> Sequence[Finding]: ...

    @property
    def supported_entities(self) -> Sequence[str]: ...

"""Caso de uso de exemplo. Troque por um real e apague este."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from evaluation.application.dto import ExemploCommand
from evaluation.application.ports import ExemploRepository
from evaluation.domain.entities import Exemplo


@dataclass(slots=True)
class ExecutarExemplo:
    repository: ExemploRepository

    async def execute(self, command: ExemploCommand) -> Exemplo:
        exemplo = Exemplo(id=str(uuid.uuid4()), project_id=command.project_id)
        await self.repository.save(exemplo)
        return exemplo

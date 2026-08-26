"""Placeholder use case. Replace it with a real one and delete this."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from evaluation.application.dto import ExampleCommand
from evaluation.application.ports import ExampleRepository
from evaluation.domain.entities import Example


@dataclass(slots=True)
class RunExample:
    repository: ExampleRepository

    async def execute(self, command: ExampleCommand) -> Example:
        example = Example(id=str(uuid.uuid4()), project_id=command.project_id)
        await self.repository.save(example)
        return example

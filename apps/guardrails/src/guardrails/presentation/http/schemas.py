"""Edge validation with Pydantic. Describes the HTTP CONTRACT, not the domain."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Language = Literal["pt", "en"]
Strategy = Literal["replace", "mask", "hash"]


class AnalyzeRequest(BaseModel):
    text: str = Field(max_length=1_000_000)
    language: Language = "pt"
    entities: list[str] = Field(default_factory=list)
    check_injection: bool = True


class RedactRequest(AnalyzeRequest):
    strategy: Strategy = "replace"


class FindingModel(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float


class InjectionSignalModel(BaseModel):
    rule: str
    score: float
    excerpt: str = ""


class InjectionModel(BaseModel):
    suspected: bool
    score: float
    signals: list[InjectionSignalModel] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    findings: list[FindingModel]
    injection: InjectionModel
    decision: Literal["allow", "redact", "block"]


class RedactResponse(BaseModel):
    text: str
    findings: list[FindingModel]
    redacted_count: int
    injection: InjectionModel
    decision: Literal["allow", "redact", "block"]

"""FastAPI routers. They only adapt input and output."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter

from aia_fastapi import AuthenticatedCaller, authenticated, health_router
from aia_telemetry import AiaAttr, annotate_active_span
from guardrails.application.dto import InspectCommand, RedactCommand
from guardrails.container import get_container
from guardrails.domain.entities import InspectionResult
from guardrails.domain.policy import RedactionStrategy
from guardrails.presentation.http.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    FindingModel,
    InjectionModel,
    InjectionSignalModel,
    RedactRequest,
    RedactResponse,
)

router = APIRouter(prefix="/v1/guardrails", tags=["guardrails"])


Authenticated = Annotated[AuthenticatedCaller, authenticated(lambda: get_container().verifier)]


def _injection_of(result: InspectionResult) -> InjectionModel:
    return InjectionModel(
        suspected=result.injection_suspected,
        score=result.injection_score,
        signals=[
            InjectionSignalModel(rule=signal.rule, score=signal.score, excerpt=signal.excerpt)
            for signal in result.injection_signals
        ],
    )


def _findings_of(result: InspectionResult) -> list[FindingModel]:
    return [
        FindingModel(
            entity_type=finding.entity_type,
            start=finding.start,
            end=finding.end,
            score=finding.score,
        )
        for finding in result.findings
    ]


@router.post("/analyze", response_model=AnalyzeResponse)
def analyze(body: AnalyzeRequest, auth: Authenticated) -> AnalyzeResponse:
    project_id = auth.project_id
    result = get_container().inspect.execute(
        InspectCommand(
            text=body.text,
            project_id=project_id,
            language=body.language,
            entities=tuple(body.entities),
            check_injection=body.check_injection,
        )
    )
    annotate_active_span(**{AiaAttr.GUARDRAIL_DECISION: result.decision.value})

    return AnalyzeResponse(
        findings=_findings_of(result),
        injection=_injection_of(result),
        decision=result.decision.value,
    )


@router.post("/redact", response_model=RedactResponse)
def redact(body: RedactRequest, auth: Authenticated) -> RedactResponse:
    project_id = auth.project_id
    result = get_container().redact.execute(
        RedactCommand(
            text=body.text,
            project_id=project_id,
            language=body.language,
            entities=tuple(body.entities),
            check_injection=body.check_injection,
            strategy=RedactionStrategy(body.strategy),
        )
    )
    annotate_active_span(
        **{
            AiaAttr.GUARDRAIL_DECISION: result.decision.value,
            AiaAttr.GUARDRAIL_REDACTED_COUNT: result.redacted_count,
        }
    )

    return RedactResponse(
        text=result.text,
        findings=_findings_of(result),
        redacted_count=result.redacted_count,
        injection=_injection_of(result),
        decision=result.decision.value,
    )


def _ready() -> dict[str, str]:
    # The detector is loaded at boot; if it exists, the service can serve.
    return {"status": "ok", "detector": get_container().detector_name}


health = health_router(ready=_ready)

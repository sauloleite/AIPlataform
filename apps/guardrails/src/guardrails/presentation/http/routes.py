"""Routers FastAPI. So adaptam entrada e saida."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header

from aia_auth import JwtVerifier, Principal, bearer_token, require_membership
from aia_errors import ProjectRequiredError
from aia_telemetry import AiaAttr, annotate_active_span
from guardrails.application.dto import InspectCommand, RedactCommand
from guardrails.container import Container, get_container
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
health_router = APIRouter(prefix="/health", tags=["health"])


def _authenticate(
    authorization: Annotated[str | None, Header()] = None,
    x_project_id: Annotated[str | None, Header()] = None,
) -> tuple[Principal, str]:
    """`Depends` so existe na apresentacao (doc 03, secao 3.3)."""
    container: Container = get_container()
    verifier: JwtVerifier = container.verifier

    principal = verifier.verify(bearer_token(authorization))
    if not x_project_id:
        raise ProjectRequiredError()

    # Servico chamando servico (o router) nao precisa ser membro do projeto.
    if principal.type != "service":
        require_membership(principal, x_project_id)

    annotate_active_span(
        **{
            AiaAttr.PROJECT_ID: x_project_id,
            AiaAttr.PRINCIPAL_ID: principal.id,
            AiaAttr.PRINCIPAL_TYPE: principal.type,
        }
    )
    return principal, x_project_id


Authenticated = Annotated[tuple[Principal, str], Depends(_authenticate)]


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
    _, project_id = auth
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
    _, project_id = auth
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


@health_router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@health_router.get("/ready")
def ready() -> dict[str, str]:
    container = get_container()
    # O detector e carregado no boot; se ele existe, o servico atende.
    return {"status": "ok", "detector": container.detector_name}

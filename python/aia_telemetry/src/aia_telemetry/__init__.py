"""OpenTelemetry with the platform conventions (ADR-009).

The same attribute names as the TypeScript side: a trace crossing router and
agent-runtime has to read as a single one.
"""

from __future__ import annotations

import os
from typing import Any, Final

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Span, StatusCode


class AiaAttr:
    """Business attributes. `project_id` is on every span."""

    PROJECT_ID: Final = "aia.project_id"
    PRINCIPAL_ID: Final = "aia.principal_id"
    PRINCIPAL_TYPE: Final = "aia.principal_type"
    ALIAS: Final = "aia.alias"
    DATA_CLASSIFICATION: Final = "aia.data_classification"
    DEPLOYMENT_ID: Final = "aia.deployment_id"
    DATA_ZONE: Final = "aia.data_zone"
    GUARDRAIL_DECISION: Final = "aia.guardrail.decision"
    GUARDRAIL_REDACTED_COUNT: Final = "aia.guardrail.redacted_count"
    ERROR_CODE: Final = "aia.error_code"


class GenAiAttr:
    """OpenTelemetry Semantic Conventions for Generative AI."""

    SYSTEM: Final = "gen_ai.system"
    OPERATION_NAME: Final = "gen_ai.operation.name"
    REQUEST_MODEL: Final = "gen_ai.request.model"
    RESPONSE_MODEL: Final = "gen_ai.response.model"
    USAGE_INPUT_TOKENS: Final = "gen_ai.usage.input_tokens"
    USAGE_OUTPUT_TOKENS: Final = "gen_ai.usage.output_tokens"


_started = False


def start_telemetry(service_name: str, *, service_version: str = "0.1.0") -> None:
    """Initialises the SDK. Calling it twice is harmless."""
    global _started
    if _started:
        return

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": service_name,
                "service.version": service_version,
                # NODE_ENV in a Python service reads oddly, but compose and
                # the chart set it for EVERY service: the environment label has
                # to match across languages or a Grafana filter splits one
                # deployment into two.
                "deployment.environment.name": os.getenv("NODE_ENV", "development"),
            }
        )
    )

    if endpoint:
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
        )

    trace.set_tracer_provider(provider)
    _started = True


def get_tracer(name: str) -> trace.Tracer:
    return trace.get_tracer(name)


def current_trace_id() -> str | None:
    """trace_id of the active span, to correlate Problem Details with the trace."""
    span = trace.get_current_span()
    context = span.get_span_context()
    if not context.is_valid:
        return None
    return format(context.trace_id, "032x")


def annotate_active_span(**attributes: Any) -> None:
    """Stamps business attributes onto the active span."""
    span = trace.get_current_span()
    for key, value in attributes.items():
        if value is not None:
            span.set_attribute(key, value)


def record_span_error(span: Span, error: BaseException, code: str | None = None) -> None:
    span.set_status(StatusCode.ERROR, str(error))
    span.record_exception(error)
    if code is not None:
        span.set_attribute(AiaAttr.ERROR_CODE, code)


__all__ = [
    "AiaAttr",
    "GenAiAttr",
    "annotate_active_span",
    "current_trace_id",
    "get_tracer",
    "record_span_error",
    "start_telemetry",
]

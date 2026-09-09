"""OpenTelemetry with the platform conventions (ADR-009).

The same attribute names as the TypeScript side: a trace crossing router and
agent-runtime has to read as a single one.
"""

from __future__ import annotations

import os
from typing import Any, Final

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
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
    #: Policy served from cache because governance was unreachable.
    POLICY_STALE: Final = "aia.policy_stale"
    #: Budget not verified because Redis was unreachable.
    BUDGET_UNVERIFIED: Final = "aia.budget_unverified"
    #: Content went out uninspected because guardrails were unreachable.
    GUARDRAILS_UNVERIFIED: Final = "aia.guardrails_unverified"
    BUDGET_RESERVED_MICROS: Final = "aia.budget.reserved_micros"
    BUDGET_COMMITTED_MICROS: Final = "aia.budget.committed_micros"
    CACHE_HIT: Final = "aia.cache_hit"
    GUARDRAIL_DECISION: Final = "aia.guardrail.decision"
    GUARDRAIL_REDACTED_COUNT: Final = "aia.guardrail.redacted_count"
    ERROR_CODE: Final = "aia.error_code"


class GenAiAttr:
    """OpenTelemetry Semantic Conventions for Generative AI."""

    #: Superseded by `PROVIDER_NAME`, and emitted anyway: a dashboard built on
    #: the old name goes empty otherwise.
    SYSTEM: Final = "gen_ai.system"
    PROVIDER_NAME: Final = "gen_ai.provider.name"
    OPERATION_NAME: Final = "gen_ai.operation.name"
    REQUEST_MODEL: Final = "gen_ai.request.model"
    REQUEST_MAX_TOKENS: Final = "gen_ai.request.max_tokens"
    REQUEST_TEMPERATURE: Final = "gen_ai.request.temperature"
    RESPONSE_MODEL: Final = "gen_ai.response.model"
    RESPONSE_ID: Final = "gen_ai.response.id"
    RESPONSE_FINISH_REASONS: Final = "gen_ai.response.finish_reasons"
    USAGE_INPUT_TOKENS: Final = "gen_ai.usage.input_tokens"
    USAGE_OUTPUT_TOKENS: Final = "gen_ai.usage.output_tokens"


class GenAiSpan:
    """Operation names, which the conventions make part of the SPAN NAME.

    A GenAI span is named `<operation> <model>`, so these are not decoration:
    a backend groups by span name, and an agent run named anything else does
    not appear beside the model calls it made.
    """

    CHAT: Final = "chat"
    EMBEDDINGS: Final = "embeddings"
    INVOKE_AGENT: Final = "invoke_agent"
    EXECUTE_TOOL: Final = "execute_tool"


_started = False
_httpx_instrumented = False


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

    # A METER provider as well as a tracer one. The Python services could
    # produce spans and had no way to produce a metric at all, so an SLI that
    # exists in TypeScript -- time to first token, cost per project -- simply had
    # no Python equivalent to emit.
    #
    # What this does NOT do is declare the metric NAMES. `AIA_METRIC` on the
    # TypeScript side lists six and nothing creates an instrument for any of
    # them; copying the list here would double a claim neither language keeps.
    # The names arrive with the instruments that emit them (roadmap M5).
    metric_readers = (
        [PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics"))]
        if endpoint
        else []
    )
    metrics.set_meter_provider(
        MeterProvider(resource=provider.resource, metric_readers=metric_readers)
    )

    _started = True


def instrument_fastapi(app: Any, *, excluded_urls: str = "health/live,health/ready") -> None:
    """Gives a FastAPI application a server span per request.

    Without this there is no active span at all, and everything downstream is
    silently thrown away: `annotate_active_span` writes onto the non-recording
    span the API returns when nothing is in context, and it neither fails nor
    warns. `opentelemetry-instrumentation-fastapi` was a declared dependency of
    this package, shipped in every Python image, and imported by nothing --
    so guardrails set `aia.guardrail.decision` on every inspection and not one
    of them ever reached a backend.

    It has to run when the application is CONSTRUCTED, not from the lifespan:
    the instrumentor adds middleware, and Starlette refuses middleware once an
    application has started.

    Health is excluded because a liveness probe every ten seconds is the
    highest-volume route in the platform and says nothing about it.
    """
    FastAPIInstrumentor.instrument_app(app, excluded_urls=excluded_urls)


def instrument_httpx() -> None:
    """Makes an outbound call a child of the request that caused it.

    Without it a trace stops at the service boundary: agent-runtime's call to
    the router opens a new trace instead of continuing the caller's, and the
    two cannot be read as one run. Global rather than per-client, because a
    client constructed deep in an adapter is not reachable from here.
    """
    global _httpx_instrumented
    if _httpx_instrumented:
        return
    HTTPXClientInstrumentor().instrument()
    _httpx_instrumented = True


def get_tracer(name: str) -> trace.Tracer:
    return trace.get_tracer(name)


def get_meter(name: str) -> metrics.Meter:
    """A meter for this service. Counterpart to `getMeter` in @aia/telemetry."""
    return metrics.get_meter(name)


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
    "GenAiSpan",
    "annotate_active_span",
    "current_trace_id",
    "get_meter",
    "get_tracer",
    "instrument_fastapi",
    "instrument_httpx",
    "record_span_error",
    "start_telemetry",
]

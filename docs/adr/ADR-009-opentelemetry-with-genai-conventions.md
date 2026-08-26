# ADR-009: OpenTelemetry with the GenAI conventions

- **Status**: accepted
- **Date**: 2026-08-25

## Context

AI telemetry has questions of its own: how many tokens, which model, how much it
cost, how long until the first token, why the answer stopped. With no convention,
each service invents an attribute name and no query works across the whole
platform.

## Decision

- **OpenTelemetry** in every service, in both ecosystems.
- **Semantic Conventions for Generative AI** for model calls: `gen_ai.system`,
  `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, with spans
  named `{operation} {model}`.
- **Business `aia.*` attributes** on every span: `project_id` always, plus
  `principal_id`, `alias`, `data_classification`, `deployment_id`, `data_zone`.
- Model-call instrumentation lives in `DeploymentExecutor`, not in each adapter:
  that way the four providers emit the SAME attributes, and a new provider
  inherits the right telemetry without anyone having to remember.
- **Prompt and response content only with project opt-in**, and only after PII
  redaction.

Destination: an OTLP endpoint. In development, the `grafana/otel-lgtm` image; in
production, anything that speaks OTLP.

## Alternatives considered

| Alternative                         | Why not                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Structured logs with our own fields | They do not correlate across services and cannot answer "where did the time go". |
| A proprietary LLM observability SDK | It ties the platform to one vendor, against ADR-012.                             |
| Our own attribute convention        | No tool would understand it without a translator.                                |

## Consequences

**Easier**: the same query works in Tempo, Jaeger, Grafana Cloud or any OTLP
backend. Cost per project falls out of an aggregation over spans.

**Harder**: the GenAI conventions are still evolving. The names are centralised
in `@aia/telemetry` and `aia_telemetry`, so following a change means editing one
file per language.

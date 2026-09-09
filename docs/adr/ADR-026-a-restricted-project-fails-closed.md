# ADR-026: a restricted project fails closed when guardrails are unavailable

- **Status**: accepted
- **Date**: 2026-09-08

## Context

`HttpGuardrail.inspect()` caught every error, returned `decision: 'allow'` with
the original text, and logged `"content proceeds unredacted"` at warn level. The
comment above it named the trade honestly: blocking all inference because the
guardrail is down would swap a risk for an outage.

Two things were wrong with it anyway.

**Nobody was told.** An `allow` from a working guardrail and an `allow` from an
unreachable one were the same value with opposite meanings. The response carried
nothing, the audit record carried nothing, and the only trace was a log line the
caller cannot see. Compare Redis, which the platform already handles correctly:
an unavailable budget ledger degrades to `budget_unverified`, the response
carries it, the console renders it, and the end-to-end suite asserts it.

**The trade is not available for every project.** The README's two headline
promises — "sensitive data does not leave here" and "PII redacted before it
leaves" — are what `restricted` means. A project carrying that classification
and sending its content to an external provider unredacted has not degraded; it
has broken the guarantee it was created to provide. ADR-010 already refuses to
send restricted data to an incompatible zone rather than sending it anyway, and
this is the same rule applied to the other control on the same path.

## Decision

**Every verdict says whether it was verified**, through a required `unverified`
field on `GuardrailVerdict`. Required rather than optional, because an adapter
that fails open has to declare it and a field it can forget is a field it will.

**Everywhere except `restricted`, the platform still answers** and reports
`guardrails_unverified` on the response, on the audit record and on the
`UsageRecorded` event. On the audit record for the same reason `data_zone` is
there: it is the residency evidence, and a record saying where the data was
processed while staying silent about whether it was redacted first answers half
the question.

**A `restricted` project is refused**, with `guardrail_unavailable` and a 503.
503 rather than 400 because nothing is wrong with the request and the same
request will succeed when the dependency returns; `retryable` says so.

A guardrail switched off by configuration counts as unverified too. It is a
different cause with the same consequence for the caller, and a restricted
project on a deployment with no guardrail is refused for the same reason.

## Alternatives considered

| Alternative                                         | Why not                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep failing open everywhere, and only add the flag | Leaves the platform's strongest promise depending on a service being up, with the breach reported in a field most callers will not read. Classification exists precisely to mark where that is unacceptable. |
| Fail closed for every project                       | The outage the original comment correctly refused. Most projects are `internal`, and their content not being scanned for a minute is a smaller harm than the platform being down for one.                    |
| Fail closed for `confidential` as well              | Defensible, and it is a policy question rather than an architectural one. It is left to governance: raise a project's classification to get the stricter behaviour.                                          |
| Retry until the guardrail answers                   | Turns a fast refusal into a slow one and holds a budget reservation while it waits. The circuit breaker in `@aia/resilience` already governs when to stop asking.                                            |
| Redact locally as a fallback                        | A second, weaker implementation of the control, kept alive only for the moments the real one is missing — which is when it would be least tested.                                                            |

## Consequences

- A restricted project now depends on `aia-guardrails` being reachable, and that
  dependency is deliberate and visible rather than implicit. Its health check
  matters more; the runbook for a degraded dependency applies.
- `guardrails_unverified` joins `policy_stale` and `budget_unverified` as the
  ways this platform says it answered while degraded. The console renders the
  first two and should render this one.
- Embeddings report `guardrails_unverified: false` rather than omitting the
  field: they do not go through the pipeline, because the text was already
  redacted when it was indexed and re-inspecting a corpus would double every
  ingestion. The field means one thing everywhere.

## Review

Revisit if `confidential` projects turn out to need the same guarantee in
practice, or if a local redaction path becomes good enough to be a real fallback
rather than a weaker duplicate.

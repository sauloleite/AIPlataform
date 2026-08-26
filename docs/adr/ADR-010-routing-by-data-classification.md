# ADR-010: Model routing conditioned on data classification

- **Status**: accepted
- **Date**: 2026-08-25

## Context

A regulated institution has to prove WHERE each piece of data was processed.
Having a written policy is not enough: the architecture has to make the violation
impossible, and the evidence has to be produced automatically.

In the original version that meant choosing between Foundry deployments in
different regions. Here it means something stronger: choosing between a model
running on this very machine and an external provider.

## Decision

- Each **project** declares a classification: `public`, `internal`,
  `confidential` or `restricted`.
- Each **deployment** declares a data zone: `local`, `br`, `us`, `eu` or
  `global`.
- `ModelSelectionPolicy` — a PURE domain rule, with no I/O — only picks
  deployments whose zone is compatible with the classification.
- The project policy may **narrow** the zones, never widen them.
- With no compatible destination, the request FAILS with
  `no_compatible_deployment`. Sending it anyway would be the violation.
- The chosen zone goes into the audit trail and into the `UsageRecorded` event.

Mapping: `restricted` accepts only `local`; `confidential` accepts `local` and
`br`; `internal` and `public` accept any zone. An unknown classification fails
CLOSED.

## Consequences

**What this solves in practice**: a `restricted` project asking for the
`chat-fast` alias — which has Gemini, OpenAI and Ollama — is served by Ollama, on
the machine itself. The external provider is never even called. With no cloud at
all, the platform solves the "sensitive data does not leave here" case.

**Automatic evidence**: the `data_zone` column in the audit trail is the
residency proof. Nobody has to remember to record anything.

**Harder**: an alias has to have coverage in a local zone to serve restricted
projects. An alias with only external providers simply does not appear to them in
`GET /v1/models` — better not to offer it than to refuse at the moment of use.

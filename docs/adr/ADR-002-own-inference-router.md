# ADR-002: Our own, lean inference router

- **Status**: accepted
- **Date**: 2026-08-25

## Context

Part of AI governance does not fit into gateway policy: budget in CURRENCY (not
tokens per minute), a routing decision conditioned on the project's data
classification, audit with business semantics, and an alias catalogue with a
lifecycle.

## Decision

`aia-inference-router` in NestJS with Clean Architecture:

- **A canonical OpenAI-compatible API** (`/v1/chat/completions`,
  `/v1/embeddings`, `/v1/models`). The consumer picks an ALIAS, never a provider.
- **Aliasing** with an ordered list of deployments by priority.
- **Budget reserve and commit** with atomic Lua scripts in Redis.
- **Policies by data classification** (ADR-010) as a pure domain rule.
- **Audit** carrying identity, project and data zone of every call.

What does NOT go in: anything configuration can solve, and any abstraction for a
provider that does not exist yet.

## Alternatives considered

| Alternative                                    | Why not                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Let the application call the provider directly | With no single point there is no budget, no audit and no data residency evidence. That is the problem the platform exists to solve. |
| Use each provider's SDK in each application    | Every model swap would become a change in N applications.                                                                           |

## Consequences

**Easier**: swapping providers means editing the alias catalogue. No consuming
application changes.

**Harder**: the router is on the critical path of every inference in the
platform. It needs an SLO, graceful degradation (`policy_stale`,
`budget_unverified`) and a load test before each release.

**Real cost**: one extra network hop between the application and the model.

## Review

Reconsider if the hop's overhead becomes measurable in time to first token (SLO
of 2 s, p95).

# ADR-003: Separate identity from governance

- **Status**: accepted
- **Date**: 2026-08-25

## Context

Finding 3.1 of reference doc 01: a single service concentrated authentication,
budget, project management and usage queries. Four distinct reasons to change
competing for the same deployment and the same database — and every service in
the platform depended on it, which made it the single point of failure.

## Decision

Two services with their own databases:

- **`aia-identity`**: who you are. Token issuance, PATs, roles, JWKS.
- **`aia-governance`**: what you may spend and where the data may go. Projects,
  budget in currency, data classification, model policies.

## Alternatives considered

| Alternative                                 | Why not                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A modular monolith with two modules         | Acceptable for a small team, but the internal boundary has to be held by discipline. Since the platform is already polyglot and distributed, the cost of two deployments is small next to the risk of eroding that boundary. |
| Three services (budget split from projects) | Budget and project change for the same reason: they are the same business decision.                                                                                                                                          |

## Consequences

**Easier**: a change in budget policy cannot bring down authentication. Release
cycles are independent.

**Harder**: one more deployment, and one more network call between them. The
router mitigates it with a local policy cache (`policy_stale`).

**Good side effect**: since identity leaves the critical path (ADR-004),
platform availability no longer depends on it for already authenticated requests.

# ADR-001: Traefik as the entry point; AI Gateway capabilities inside the router

- **Status**: accepted (revises ADR-001 of reference doc 02)
- **Date**: 2026-08-25

## Context

Reference doc 02 chose Azure API Management for two roles: single API entry point
and AI Gateway for Foundry, with token limits, content inspection, load balancing
with a circuit breaker and a semantic cache configured as policy.

The reasoning was sound: those capabilities are commodity in managed gateways,
and reimplementing them means maintaining infrastructure that differentiates
nobody.

This platform has no cloud. APIM does not exist here, and the closest open source
API gateways (Kong, Apigee) either lack the LLM policies or bring an operational
surface larger than the problem they solve.

## Decision

Split the role in two:

1. **Traefik** as the entry point: TLS, routing, per-route rate limiting and
   automatic service discovery. That is what a reverse proxy does well, and
   Traefik does it with nothing but labels.

2. **The AI Gateway capabilities live inside `aia-inference-router`**, as code:
   `DeploymentPool` does priority-based load balancing with failover and a
   per-deployment circuit breaker, the `max_tokens` ceiling comes from
   `ModelSelectionPolicy`, the cache lives in `RedisSemanticCache` and content
   inspection goes to `aia-guardrails`.

## Alternatives considered

| Alternative                    | Why not                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kong with AI Gateway           | It brings its own control plane and one more database to operate. The gain would be configuring in YAML what we already have as tested code.                                                           |
| LiteLLM as a proxy             | It covers provider routing well, but has no budget in currency, no policy by data classification and none of the audit we need. It would leave one more layer on the critical path doing half the job. |
| Only the router, with no proxy | TLS, redirection and edge rate limiting would have to be implemented in every service.                                                                                                                 |

## Consequences

**Easier**: AI Gateway behaviour became TypeScript with unit tests. Load
balancing policy written in gateway XML is notoriously hard to test; here a
failover between deployments is a 15-line test.

**Harder**: we now maintain that behaviour. Circuit breaker, retry with jitter
and cache are our code, with our bugs. The mitigation is that this logic lives in
`@aia/resilience`, shared and covered by tests.

**Accepted consequence**: Traefik does not validate JWTs. Each service validates
locally against the JWKS, which was already the ADR-004 decision and still holds.

## Review

Reconsider if the platform ends up deployed predominantly on a single cloud with
a managed gateway, or if the balancing and cache code starts producing recurring
incidents.

# Production readiness (per service)

From reference doc 03 §13. Use it as a gate: a service only goes to production
with every item ticked, or with the exception recorded in an ADR.

## Contract

- [ ] OpenAPI or AsyncAPI published under `contracts/`
- [ ] Errors as Problem Details with a stable code from the catalogue
- [ ] Path versioning (`/v1`) and deprecation with 90 days' notice
- [ ] `X-Project-Id` required, or its absence justified
- [ ] `Idempotency-Key` on any POST that creates a resource or consumes budget
- [ ] Opaque cursor pagination on every list

## Tests

- [ ] Domain unit tests (no I/O) and application unit tests (with fakes, not mocks)
- [ ] **Every error path has a test**, not only the happy path
- [ ] The architecture test passes, and is demonstrably able to fail
- [ ] Contract test against the OpenAPI
- [ ] Integration against a real dependency in a container
- [ ] Domain and application coverage above 80%

## Observability

- [ ] Traces with `aia.project_id` on every span
- [ ] `gen_ai.*` on model calls (where applicable)
- [ ] Structured logs, **with no PII**, carrying `trace_id`
- [ ] SLI metrics published
- [ ] SLO dashboard and alerts

## Resilience

- [ ] A declared `@aia/resilience` policy (do not invent your own retry)
- [ ] Graceful degradation defined and tested for each dependency
- [ ] Separate health checks: liveness does not query a dependency
- [ ] Graceful shutdown with connection draining
- [ ] CPU and memory limits, HPA or KEDA configured

## Security

- [ ] No secret in an environment variable (ADR-015)
- [ ] Authorisation by Specification, with the decision recorded in the trace
- [ ] Distroless image, no root, read-only filesystem
- [ ] SBOM published, image signed, no critical vulnerability with a fix available
- [ ] Threat model reviewed; tools classified by risk where applicable

## Data and regulatory

- [ ] Data classification and retention configured (TTL in the database)
- [ ] PII redaction before any content is persisted
- [ ] The data flow present in the compliance inventory
- [ ] Data zone recorded in the audit trail (residency evidence)

## Operations

- [ ] Runbook written **and executed at least once** in a game day
- [ ] A defined owner (on-call)
- [ ] ADRs up to date

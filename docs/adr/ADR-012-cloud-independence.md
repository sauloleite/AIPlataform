# ADR-012: Cloud independence through ports

- **Status**: accepted (new; it does not exist in reference doc 02)
- **Date**: 2026-08-25

## Context

The reference documents design the platform on Azure: APIM, Foundry, Cosmos DB,
AI Search, Service Bus, Key Vault, Entra ID, Application Insights. That decision
is defensible for an institution that has already standardised on Azure.

The goal here is different: **anyone should be able to stand up their own AI
platform**, on a laptop, on a VPS, on a company server or on any cloud. That
changes the selection criterion for every piece of infrastructure.

## Decision

**Every managed piece becomes a port with an open source, self-hostable default
implementation.** Changing cloud — or using none — becomes swapping an adapter,
never rewriting a use case.

| Role               | OSS default                          | Port                         |
| ------------------ | ------------------------------------ | ---------------------------- |
| Entry point        | Traefik                              | —                            |
| AI Gateway         | inside `aia-inference-router`        | `ModelProvider`              |
| Models             | OpenAI, Gemini, Anthropic, Ollama    | `ModelProvider`              |
| Identity           | `aia-identity` (its own OIDC issuer) | —                            |
| Documents          | MongoDB                              | `*Repository`                |
| Cache and counters | Redis                                | `BudgetLedger`               |
| Events and queues  | Redis Streams, BullMQ                | `EventPublisher`, `JobQueue` |
| Objects            | MinIO                                | `ObjectStore`                |
| Vectors            | Qdrant                               | `VectorIndex`                |
| Analytics          | MongoDB time-series                  | `AnalyticsStore`             |
| Guardrails         | Presidio + heuristics                | `Guardrail`                  |
| Observability      | OTel Collector + Grafana LGTM        | —                            |
| Deployment         | docker-compose and Helm              | —                            |

Practical rule: **no cloud SDK in `application/` or `domain/`**.
`dependency-cruiser` and `import-linter` fail the CI.

## Alternatives considered

| Alternative                              | Why not                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Follow the Azure design                  | It excludes anyone without Azure, which is most of the people who want to run their own platform.                     |
| An off-the-shelf multi-cloud abstraction | Generic abstractions deliver the lowest common denominator and still leak. One port per concrete need is more honest. |
| Cloud-specific code, with branches       | It multiplies code paths and tests.                                                                                   |

## Consequences

**Easier**: `make dev` brings up the whole platform with no account, no key and
no credit card. With Ollama it genuinely answers, at zero cost.

**Harder**: we lose managed capabilities that would have come for free — APIM's
semantic cache, AI Search's reranker, Foundry's PTU. Each becomes our own code or
falls out of scope, with the decision recorded.

**Unexpected upside**: Ollama as the `local` zone gave ADR-010 a stronger answer
than the original version had. Keeping data inside the country is one thing; not
letting the data leave the machine is another.

## Review

Reconsider if the platform ends up deployed exclusively on one cloud and the cost
of maintaining the OSS adapters outweighs the value of portability.

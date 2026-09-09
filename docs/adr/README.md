# Architecture Decision Records (ADR)

Every structural decision lives here. Without an ADR a choice becomes folklore:
nobody remembers why it was made, and nobody feels authorised to change it.

ADRs 001 to 011 come from `docs/reference/02-arquitetura-alvo.md`, which assumes
Azure as the primary cloud. This platform is **cloud-agnostic and open source**,
so several were rewritten: each states explicitly what changed relative to the
original and why. ADRs 012 to 015 are new and exist precisely because of that
change of context.

| ADR                                                                | Decision                                                                      | Status                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------- |
| [001](ADR-001-entry-point-and-ai-gateway.md)                       | Traefik as entry point; AI Gateway capabilities in the router                 | accepted (revises the original)     |
| [002](ADR-002-own-inference-router.md)                             | Our own, lean inference router                                                | accepted                            |
| [003](ADR-003-separate-identity-from-governance.md)                | Separate identity from governance                                             | accepted                            |
| [004](ADR-004-local-jwt-validation.md)                             | Local JWT validation with JWKS                                                | accepted                            |
| [005](ADR-005-a-single-agent-runtime.md)                           | A single agent runtime                                                        | accepted (LangGraph revised by 018) |
| [006](ADR-006-qdrant-as-vector-index.md)                           | Qdrant as the default vector index                                            | accepted (replaces AI Search)       |
| [007](ADR-007-mongodb-as-document-database.md)                     | MongoDB as the document database                                              | accepted (replaces Cosmos DB)       |
| [008](ADR-008-redis-streams-and-bullmq.md)                         | Redis Streams and BullMQ for events and jobs                                  | accepted (replaces Service Bus)     |
| [009](ADR-009-opentelemetry-with-genai-conventions.md)             | OpenTelemetry with the `gen_ai.*` conventions                                 | accepted                            |
| [010](ADR-010-routing-by-data-classification.md)                   | Model routing conditioned on data classification                              | accepted                            |
| [011](ADR-011-monorepo.md)                                         | A monorepo for the core                                                       | accepted                            |
| [012](ADR-012-cloud-independence.md)                               | Cloud independence through ports                                              | accepted (new)                      |
| [013](ADR-013-analytics-on-mongodb.md)                             | Analytics on MongoDB time-series, ClickHouse behind the port                  | accepted (new)                      |
| [014](ADR-014-our-own-guardrails.md)                               | Our own guardrails with Presidio                                              | accepted (new)                      |
| [015](ADR-015-secrets-without-a-managed-vault.md)                  | Secrets without a managed cloud vault                                         | accepted (new)                      |
| [016](ADR-016-knowledge-owns-the-vector-store.md)                  | aia-knowledge owns the vector store; one collection per shape                 | accepted (new)                      |
| [017](ADR-017-references-resolved-as-the-caller.md)                | Cross-service references resolved as the caller                               | accepted (new)                      |
| [018](ADR-018-the-agent-loop-is-written-out.md)                    | The agent loop is written out, not delegated to a graph library               | accepted (new)                      |
| [019](ADR-019-the-agent-decides-which-store-is-searched.md)        | An agent may search only the stores its definition attaches                   | accepted (new)                      |
| [020](ADR-020-an-external-tool-never-sees-the-platform-token.md)   | An external tool is authenticated by its Connection, never the caller's token | accepted (new)                      |
| [021](ADR-021-an-evaluation-refuses-rather-than-scores-nothing.md) | An evaluation refuses rather than reporting a verdict it did not measure      | accepted (new)                      |
| [022](ADR-022-search-fuses-two-rankings.md)                        | Search fuses a lexical ranking with the vector one                            | accepted (new)                      |
| [023](ADR-023-a-store-is-shared-by-two-consents.md)                | A knowledge store is shared by two consents                                   | accepted (new)                      |
| [024](ADR-024-gateway-api-replaces-ingress.md)                     | The Gateway API replaces the Ingress in the Helm chart                        | accepted (new)                      |
| [025](ADR-025-tool-arguments-are-validated-at-the-gateway.md)      | Tool arguments are validated against their schema at the gateway              | accepted (new)                      |
| [026](ADR-026-a-restricted-project-fails-closed.md)                | A restricted project fails closed when guardrails are unavailable             | accepted (new)                      |
| [027](ADR-027-the-data-zone-rule-has-one-source.md)                | The data-zone rule has one source, generated into both languages              | accepted (new)                      |

Format: context, decision, alternatives, consequences and review trigger.
Template in [TEMPLATE.md](TEMPLATE.md).

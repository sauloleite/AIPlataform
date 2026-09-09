# Roadmap

What is built, what is next, and why in that order.

`docs/reference/03-guia-implementacao-do-zero.md` §10 carries the original
six-phase plan. It is kept unaltered, in Portuguese, and it assumes Azure — it
is the source this work started from, not the plan being executed. **This file
is the plan being executed.**

## Built

| Capability                                                  | Service                | Decided by                |
| ----------------------------------------------------------- | ---------------------- | ------------------------- |
| One OpenAI-compatible entry point, aliasing, 4 providers    | `aia-inference-router` | ADR-001, ADR-002          |
| Budget reserved and committed atomically, in currency       | `aia-inference-router` | ADR-002                   |
| Routing conditioned on data classification                  | `aia-inference-router` | ADR-010                   |
| Local JWT with JWKS, PAT, service credentials               | `aia-identity`         | ADR-003, ADR-004          |
| Projects, budget, classification, policies                  | `aia-governance`       | ADR-003                   |
| Brazilian PII redaction and prompt-injection heuristics     | `aia-guardrails`       | ADR-014                   |
| Versioned assets: agents, tools, prompts                    | `aia-registry`         | ADR-017                   |
| Stores, async ingestion, hybrid search, security trimming   | `aia-knowledge`        | ADR-006, ADR-016, ADR-022 |
| A store shared across projects by two consents              | `aia-knowledge`        | ADR-023                   |
| Governed tools: allow-list, risk, human approval, audit     | `aia-mcp-gateway`      | ADR-020                   |
| An agent loop written out, with checkpoints and HITL        | `aia-agent-runtime`    | ADR-005, ADR-018, ADR-019 |
| Evaluation suites that refuse rather than misreport         | `aia-evaluation`       | ADR-021                   |
| The console: projects, agents, stores, tools, traces, evals | `aia-web`              | —                         |
| Events through an outbox, published to Redis Streams        | five services          | ADR-008                   |

## Not built

Two services from the target architecture do not exist yet.

- **`aia-document-processing`** — PDF, DOCX, XLSX, image and audio parsing, and
  template-driven structured extraction. Until it exists, `aia-knowledge` parses
  text, Markdown and JSON, and any other upload fails that job with
  `unsupported_media_type`. The `DocumentParser` port and the array-based
  injection in `stores.module.ts` are already shaped to accept it.
- **`aia-data-platform`** — usage analytics (Bronze, Silver, Gold), cost
  showback, and budget reconciliation. The producer side is finished: five
  services publish through an outbox. Nothing consumes those streams yet, which
  is why there is no cost-per-project view and why the reconciliation
  `docs/runbooks/redis-unavailable.md` describes cannot be run.

## Next, in order

The order is not arbitrary. Two rules set it: the shared libraries come before
the two new Python services, or the duplication they already have triples; and
evaluation and telemetry come before any change to retrieval, context or
routing, because none of those can be judged without a measurement.

| #   | Milestone                                        | Why it comes here                                                                     |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| M1  | ~~The repository stops lying~~ **done**          | A plan built on a false description of the system is a guess                          |
| M2  | ~~Delivery is real, and CI defends it~~ **done** | Helm ships 6 of 11 services; nothing in CI compares a route to its contract           |
| M3  | ~~Connect what is already built~~ **done**       | The bulkhead, the tool-argument schema and the TTFT heartbeat need wiring, not design |
| M4  | ~~Python parity and the two SDKs~~ **done**      | The next two services are Python, and `_authenticate` is already written three times  |
| M5  | ~~Telemetry that emits~~ **done**                | Six metrics are declared and no instrument exists, so no SLO dashboard can            |
| M6  | Evaluation that gates                            | Everything after this must be provable, not asserted                                  |
| M7  | `aia-document-processing`                        | Unblocks every document that is not plain text                                        |
| M8  | `aia-data-platform` and FinOps                   | Gives the published events a consumer                                                 |
| M9  | `aia-memory`                                     | Agent memory does not exist; `thread_id` is carried and never used                    |
| M10 | Retrieval quality                                | Reranking and contextual retrieval, measured against M6                               |
| M11 | Context engineering in the loop                  | Compaction and a context budget, measured against M6                                  |
| M12 | Gateway: tokens, prefix cache, cascade           | Per-token limits and provider caching, measured against M6                            |
| M13 | Injection architecture and delegated authority   | Provenance, isolation patterns, RFC 8693 token exchange                               |

Each milestone is independently shippable. Stopping after any of them leaves a
coherent platform rather than a half-finished one.

## Deliberately not doing

- **A graph database for memory.** The published evidence does not support the
  cost: a graph variant scored 68.44 against 66.88 with roughly three times the
  search latency and twice the tokens, and a plain agent with files scored
  higher than both. It stays an extension point behind the memory port.
- **A graph framework for the agent loop.** ADR-018 decided this, and nothing
  since has changed the shape of the problem.
- **MongoDB-native vector search as the default.** ADR-006 chose Qdrant and
  ADR-012 put it behind a port; a Mongo adapter remains possible there.
- **A2A.** Nothing in this roadmap needs agent-to-agent communication. It earns
  an ADR when there is a second runtime to talk to.
- **Fine-tuning and automatic prompt optimisation.** The adaptation ladder says
  to exhaust the rung below first and prove it with a number. M6 is what makes
  that provable.
- **Pydantic models generated from every OpenAPI document.** The Python
  contracts package generates the one thing the two languages must agree on
  byte for byte -- ADR-027's data-zone table -- and nothing else. A model tree
  generated from ten documents would be a second source of truth for every
  request shape, drifting against the TypeScript one with nothing comparing
  them, and what a client sends is validated by the platform, which is the only
  place that can validate it. `aia_sdk` therefore hand-writes its request and
  response types, and says so where they are defined.

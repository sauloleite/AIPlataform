# ADR-016: aia-knowledge owns the vector store, and one collection per embedding shape

- **Status**: accepted
- **Date**: 2026-08-27

## Context

Reference doc 02 §3 lists "knowledge stores" twice: among the assets owned by
`aia-registry`, and among the responsibilities of `aia-knowledge`. Two owners
for one concept is exactly finding 3.4 of doc 01 — the double source of truth
between Graph API, Agent Studio and Knowledge Management that this architecture
exists to remove.

ADR-006 chose Qdrant but left the collection layout open. The obvious reading,
one collection per store, turns out to be the wrong one.

## Decision

**`aia-knowledge` owns the vector store outright** — its definition, its
documents and its index. `aia-registry` holds no copy. An agent definition
references a store by id, and the registry validates that reference when the
agent is published, over the contract.

**One Qdrant collection per embedding shape**, named `aia_chunks_{dimensions}_{distance}`,
not one per store. All tenancy lives in the payload.

**Chunk text lives in MongoDB**, not in the Qdrant payload. The payload carries
only what the filter reads: `project_id`, `store_id`, `document_id`, `version`,
`chunk_index` and the ACL fields.

## Alternatives considered

| Alternative                                             | Why not                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store definition in the registry, contents in knowledge | The definition and the index would drift, and the chunking strategy is not meaningful without the vectors it produced.                                                                                                                                            |
| One collection per store                                | It pushes the tenant boundary into the collection NAME, so a bug in name derivation becomes a cross-tenant leak with no filter left to catch it. Qdrant's own multitenancy guidance also discourages it: each collection carries its own segments and HNSW graph. |
| One global collection                                   | A collection has one fixed vector width, and `embedding-default` fans out across providers whose widths differ (1536 and 768 among the current ones).                                                                                                             |
| Chunk text in the payload                               | It would save one round trip and cost a slower filter on every search, with the document body sitting in the index rather than only its ACL.                                                                                                                      |

## Consequences

**Easier**: the store has one owner, so there is nothing to reconcile. The
mandatory `project_id` filter is cheap because `is_tenant` co-locates a
project's points on disk.

**Harder**: search pays a MongoDB hydration round trip for the chunk text. It
needed one anyway, for citations and for the hybrid half of ADR-006.

**Fixed at creation**: the embedding alias, the model it resolved to and the
vector width. Changing the model invalidates every vector already written, so
that is a new store rather than an edit — and ingestion refuses a vector of the
wrong width rather than corrupting the index silently.

## Review trigger

If a single tenant grows large enough that its points dominate a collection,
revisit the layout: Qdrant supports sharding by a tenant key, which would keep
the payload filter while separating the storage.

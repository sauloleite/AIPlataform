# ADR-006: Qdrant as the default vector index

- **Status**: accepted (replaces AI Search from the original ADR-006)
- **Date**: 2026-08-25

## Context

Reference doc 02 chose Azure AI Search for its hybrid search, semantic reranker
and integrated security filters. Without Azure, a self-hostable equivalent is
needed.

The requirement that cannot be lost is **security trimming**: the search has to
filter by `project_id` and by document ACL WITHIN the query, not afterwards.
Filtering client-side leaks results and breaks pagination on top of that.

## Decision

**Qdrant** as the default implementation of the `VectorIndex` port: open source,
Apache 2.0, runs in one container, and its payload filter is applied during the
vector search — which is exactly what security trimming requires.

Hybrid search: vectors in Qdrant combined with MongoDB's text index.

## Alternatives considered

| Alternative                 | Why not                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| pgvector                    | Excellent when a Postgres already exists. It brings one more database to a platform that has already standardised on MongoDB. |
| MongoDB Atlas Vector Search | It would avoid a component, but it is not self-hostable: it would tie the platform to Atlas, against ADR-012.                 |
| Chroma                      | Simpler, but with a history of API changes and less mature payload filtering.                                                 |
| Elasticsearch/OpenSearch    | Does hybrid search very well, at the cost of much heavier operations.                                                         |

## Consequences

**Easier**: vector search with security filtering and no managed service at all.

**Harder**: the semantic reranker does not come for free. When it is needed, it
enters as an explicit reranking step in the router.

**No lock-in**: the `VectorIndex` port keeps it possible to swap in AI Search,
pgvector or Vertex AI Search without touching a use case.

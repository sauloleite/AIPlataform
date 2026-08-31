# ADR-022: Search fuses a lexical ranking with the vector one

- Status: accepted
- Date: 2026-08-30
- Supersedes part of: nothing. Completes what the M2 plan promised and did not ship.

## Context

`aia-knowledge` searched by nearest neighbour alone. The M2 plan said hybrid
search would follow inside the same milestone -- "the Mongo text index and RRF
fusion follow in the same milestone" -- and only half of it landed: the
`chunk_text` index was created on every ingestion and no query ever read it.

Measured against a real store on `gemini-embedding-001` (3072 dimensions), the
vector ranking is much better at prose than the folklore suggests. Asked for an
exact error code among four near-identical chunks it was right four times out
of four, by a wide margin (0.79 against 0.63). Asked a natural-language
question it was right with an even wider one (0.77 against 0.58).

Where it failed was short, low-context queries. `"365"` returned the expense
policy above the retention policy -- the only chunk containing 365 -- by 0.003.
`"120"` did the same. In those cases every score sat between 0.526 and 0.538:
the model was not choosing wrongly so much as not choosing, and the order fell
out of noise.

## Decision

Search fuses two rankings with **Reciprocal Rank Fusion**, `k = 60`, and hybrid
is the default mode. `vector` remains available, as an escape hatch and as the
way to measure what fusion changes.

RRF rather than score normalisation, because cosine and MongoDB's `textScore`
are not comparable and min-max normalising makes every score depend on the
worst result in the batch. RRF reads positions and throws the scores away.

Each ranking contributes `max(top_k * 4, 20)` candidates. Fusing the top `k` of
each would defeat the purpose: the chunk worth finding is the one the vector
ranking places twentieth and the lexical one places first.

Three supporting decisions:

- **The lexical index is `{projectId, storeId, text}`**, not `{projectId, text}`.
  MongoDB refuses a `$text` query against a compound text index unless the
  query supplies equality on every preceding key, so the tenant and the store
  cannot be omitted by accident. The storage engine enforces what the port
  signature already asks for.
- **`default_language: 'none'`**, so no stemming and no stop-word removal. The
  vector ranking is already good at prose; this one exists to catch what it
  misses, which is literal tokens. A stemmer helps the first job and damages
  the second.
- **Chunks carry `storeId` and the ACL**, denormalised from the document. Without
  them the lexical query could scope to the project but not to the store, and
  the missing clause would have to be applied to the results -- which is the
  post-filtering ADR-006 exists to forbid.

## Consequences

`TrimmingSpec` is now translated twice, by `filterFor` (Qdrant) and
`textQueryFor` (MongoDB). A chunk one admits and the other refuses is a leak in
whichever direction it runs, so a test compares the two translations rather
than only checking each alone.

The `score` field changes meaning between modes: cosine in `vector`, the fused
value in `hybrid`. They are not on one scale. The response therefore also
carries `retrieval` (`vector | text | both`) and `vector_score`, so a consumer
can still read a cosine where one exists.

Chunks written before this decision have no `storeId` and no ACL fields, so the
lexical query does not match them -- fail-closed, and they return to the
ranking on their next ingestion. The vector ranking is unaffected, so search
degrades in quality rather than breaking.

A failing lexical query is **not** caught and degraded. Both rankings read
infrastructure that must be up, and hydration hits MongoDB anyway: a silent
half-search would return worse answers with no signal that anything was wrong.

## What was considered and rejected

- **Normalising both scores into one scale.** Unstable per query, for the reason
  above.
- **Reranking with a cross-encoder.** It would help more than fusion does, and
  it needs a model, a budget path and a latency allowance. Not refused on
  merit -- out of scope, and worth its own decision.
- **A per-store lexical language.** `none` is a compromise between a Portuguese
  and an English corpus. If a store's language ever matters enough, it belongs
  next to the chunking strategy, chosen at creation.

# ADR-023: A knowledge store is shared by two consents

- Status: accepted
- Date: 2026-08-30
- Refines: ADR-006 (the tenant filter), ADR-016 (knowledge owns the store)

## Context

A knowledge base is expensive to build and identical across projects more often
than not: the same runbook, the same policy handbook, the same product
documentation. Copying it into every project means paying to embed the same
bytes repeatedly and, worse, maintaining several copies that drift.

The platform had no way to express this. `trimmingSpecFor` refused outright:

```ts
if (input.store.projectId !== projectId) {
  throw new InternalError('a search was built for a store in another project');
}
```

That refusal was correct for the model at the time, in which the project WAS
the boundary of everything.

## Decision

A store may be reused across projects, and it takes **two consents**.

1. The owning project sets `visibility: public`. That offers the store to a
   catalogue and does nothing else.
2. The consuming project subscribes. Only then does anything cross.

Publishing by mistake therefore exposes a listing, not the contents.

### The tenant clause pins the OWNER, not the reader

`store_id` already implies the owning project: every chunk in store Y belongs,
by construction, to whoever created Y. So the `project_id` clause was never the
boundary -- it was defence in depth. Sharing keeps both clauses fixed to single
values by pinning `project_id` to the store's owner rather than to the caller.

Two consequences fall out of that, both good. The filter is exactly as tight as
before. And Qdrant's `is_tenant` co-location keeps working: a cross-project
search still lands inside one tenant's partition.

### Only public documents cross

A subscriber's ACL groups are roles held in **their** project. `finance` in one
project is not `finance` in another, and a document restricted to the second
was never offered to the first. The principal branch goes too: a document named
for a user was restricted by its owner inside their own project, and
subscribing to the store is not that owner's consent to re-scope it.

So `trimmingSpecFor` empties `aclGroups` and `aclPrincipals` at the source
rather than leaving each translation to remember. An adapter has no
`crossProject` branch to get wrong, because the lists it translates arrive
empty. The same rule is applied a second time when hydrating, and the two
layers were verified to be independent: removing either alone still refuses.

### Refusal is 404, never 403

A project that may not read a store must not learn that it exists. A 403
answers "yes, and it is not yours", which turns id guessing into a census of
every store on the platform. `accessTo` throws `StoreNotFoundError`, and so
does subscribing to a store that was never published.

### Withdrawing revokes

Setting a store back to `private` drops every subscription. Leaving them would
mean republishing later silently restores everyone's access, which is not what
withdrawing meant.

## Consequences

Writes stay with the owner. Registering a document, deleting one and deleting
the store all read through the project-scoped `findById`, so a subscriber gets
the same not-found a stranger gets. Only the read paths resolve across
projects, and they do it through one shared `ResolveReadableStore` so the
question is asked the same way everywhere.

`findByIdAcrossProjects` is the one repository read with no tenant in the
query. It is named at that length on purpose, and every caller owes an
`accessTo` decision before touching the result. Reaching for it because
`findById` returned null is how this feature becomes a cross-tenant read.

### An alias is not the same thing in two projects

A subscriber's query embedding is charged to the subscriber, which is right --
they asked the question. But the store's `embeddingAlias` resolves through the
router under the CALLER's data-classification policy, and that makes it a
different model in a different project.

This is not theoretical; it was the first thing that happened. In the local
environment a project classified `internal` resolves `embedding-default` to
Gemini at 3072 dimensions, and a project classified `restricted` resolves the
same alias to `ollama-embed`, which had no reachable deployment at all. The
subscription succeeded and every search then answered 503.

Embedding the query under the OWNER's project would make it work, and would be
wrong: the question is the subscriber's data, and routing it under somebody
else's policy is precisely the residency rule the subscriber declared. A
project restricted to local models would have its questions sent to a hosted
provider by subscribing to a store.

So `SubscribeToStore` probes the alias with the subscriber's own token before
accepting, the way `CreateStore` probes it at creation, and refuses an
incompatible pair once with a reason instead of at every search with a 503
nobody can act on. A width that differs raises `embedding_dimension_mismatch`;
an alias that does not resolve at all is refused with the policy named as the
cause.

`ListStores` appends subscribed stores only on the first page. They belong to
another project and do not share this one's cursor ordering, so interleaving
them would make the cursor lie.

## What was considered and rejected

- **Public means every project, immediately.** Simplest, and the wrong default
  for an installation whose projects belong to different customers: one
  mis-click would expose a knowledge base to all of them.
- **An explicit allow-list of consuming projects.** Tighter, and it does not
  scale to a catalogue anybody may browse. It remains the natural next step if
  a deployment needs it -- the subscription record is already per project.
- **Copying the store into the consuming project.** The problem this decision
  exists to remove.

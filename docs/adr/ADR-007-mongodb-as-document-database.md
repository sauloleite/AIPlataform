# ADR-007: MongoDB as the document database

- **Status**: accepted (replaces Cosmos DB from the original ADR-007)
- **Date**: 2026-08-25

## Context

Reference doc 02 chose Cosmos DB for MongoDB (vCore) to keep the MongoDB API with
managed replication. Without Azure, we use MongoDB directly.

Two capabilities are requirements, not preferences:

- **Multi-document transactions**, because the outbox pattern writes the state
  and the event in the same transaction. Without it, a crash between the two
  writes leaves the system inconsistent.
- **TTL indexes**, so audit and conversation retention (LGPD) is enforced by the
  database rather than by a job someone may forget to monitor.

## Decision

**MongoDB 8** in a replica set (even a single-node one in development, because
transactions require a replica set). One database per service.

## Alternatives considered

| Alternative            | Why not                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL             | Technically superior in several respects, and it would allow unifying with pgvector. Dropped because the reference documents, the data model and the team's experience assume MongoDB; the swap would be a rewrite with no proportional gain. |
| Cosmos DB / DocumentDB | It would tie the platform to one cloud (ADR-012).                                                                                                                                                                                             |
| SQLite                 | Too simple for multiple replicas.                                                                                                                                                                                                             |

## Consequences

**Easier**: one `docker compose up` brings the whole database. The same code runs
against self-hosted MongoDB, Atlas, Cosmos DB or DocumentDB.

**Harder**: a replica set is mandatory even in development, which surprises
anyone expecting a bare `mongod`. Compose already initialises it on its own.

**Operational consequence**: backup is the host's responsibility. The restore
runbook covers the procedure.

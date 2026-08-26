# ADR-013: Analytics on MongoDB time-series, ClickHouse behind the port

- **Status**: accepted (new)
- **Date**: 2026-08-25

## Context

Reference doc 02 uses Azure Data Explorer with a Medallion architecture for
usage, cost and audit. ADX is excellent and expensive, and it has no direct OSS
equivalent that is equally simple to operate.

The real volume deserves to be stated honestly: a platform with 500 active users
generates something like tens of thousands of inference events per day. That is
not columnar-database volume.

## Decision

**Start with MongoDB time-series collections** for the Bronze, Silver and Gold
layers, behind the `AnalyticsStore` port. MongoDB is already mandatory, it
already aggregates well enough for cost per project, per alias and per user, and
it has TTL indexes for retention.

**ClickHouse enters behind the same port** once volume justifies it — and the
trigger is measurable, not a matter of opinion: when the daily cost aggregation
takes more than 30 s, or when hot retention passes 100 million events.

## Alternatives considered

| Alternative               | Why not NOW                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| ClickHouse from the start | One more stateful service to operate, for a volume MongoDB handles. It remains the next choice. |
| DuckDB over Parquet       | Great for local analysis, poor for continuous concurrent writes.                                |
| Keep everything in logs   | It cannot answer "how much did project X spend this month" without scanning everything.         |

## Consequences

**Easier**: zero new components. FinOps falls out of an aggregation over data
that is already there.

**Harder**: analytical queries compete with transactional load in the same
database. Mitigated by separate collections and by reading from a secondary
replica.

**Debt taken on and recorded**: this ADR exists so that swapping to ClickHouse is
a planned decision with a defined trigger, rather than a discovery during an
incident.

# ADR-005: A single agent runtime

- **Status**: accepted
- **Date**: 2026-08-25

> **Revised in part by [ADR-018](ADR-018-the-agent-loop-is-written-out.md).**
> The decision that stands is _one_ runtime for every agent. The choice of
> LangGraph as the loop inside it did not: the platform already owns the state,
> the checkpointer port and the branch, and the framework would have been
> adapted to the architecture rather than doing work for it.

## Context

Finding 3.5 of reference doc 01: the previous platform ran agents on three
different frameworks inside the same service. Three mental models of state,
memory, streaming and tool calling.

In a regulated context the cost is higher than it looks: each runtime needs the
same security review against excessive agency (OWASP LLM06), the same
instrumentation and the same audit trail. Three times over.

## Decision

**LangGraph** as the single runtime, for its durable execution with a
checkpointer and its native support for interrupting for human approval — the two
requirements this platform has that are not trivial to build.

In this phase `aia-agent-runtime` is a skeleton with the right layer structure
and the right ports; the graph arrives in roadmap phase 3.

## Alternatives considered

| Alternative                             | Why not                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Write our own runtime                   | Durable execution with exact resumption is a solved problem; rewriting it would be work with no edge. |
| Keep several runtimes                   | Rejected on KISS grounds and on the tripled cost of security review.                                  |
| An agent framework tied to one provider | It contradicts cloud independence (ADR-012).                                                          |

## Consequences

**Easier**: one state model, one instrumentation, one security review.

**Harder**: a dependency on an external framework on the agent execution path.
The `ModelClient` port and `container.py` isolate LangGraph from the domain,
which keeps the swap possible.

## Review

Reconsider in 12 months, or sooner if LangGraph stops supporting durable
execution the way the platform needs.

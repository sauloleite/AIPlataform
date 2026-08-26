# ADR-011: A monorepo for the core

- **Status**: accepted
- **Date**: 2026-08-25

## Context

The platform has services in two languages, contracts shared between them, five
cross-cutting libraries and versioned infrastructure.

The real problem with a polyrepo here: changing a contract requires a PR in the
contracts repository, waiting for a release, and then PRs in each consumer.
During that interval the system is inconsistent and nobody knows.

## Decision

One monorepo with pnpm workspaces (TypeScript), a uv workspace (Python) and Nx
for affected builds. Contracts, libraries, services, infrastructure and
documentation in the same place. Products that only consume the platform through
the SDK live in their own repositories.

## Alternatives considered

| Alternative                | Why not                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| Polyrepo                   | A contract change stops being atomic.                                         |
| A TypeScript-only monorepo | It would leave the Python services out of the same contracts and the same CI. |

## Consequences

**Easier**: changing a contract and its consumers in ONE PR, with CI checking
both sides together. The Clean Architecture dependency rule is verifiable across
the whole codebase at once.

**Harder**: CI needs selective builds, or every PR runs everything. Solved with
`nx affected` and `uv`.

**Requires discipline**: physical proximity does not authorise coupling.
`dependency-cruiser` explicitly forbids one service importing another's domain,
and CI proves the rule really fails when violated.

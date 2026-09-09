# Conventions of this repository

An open source, cloud-agnostic AI platform. A polyglot monorepo: NestJS and
FastAPI, with shared libraries mirrored across both languages.

## Commands

```bash
make bootstrap    # installs pnpm, uv and the dependencies
make dev          # brings everything up in containers
make check        # what CI runs: lint, types, architecture, tests
make arch         # just the dependency rule
make e2e          # flow 7.1 against the local environment
make contracts    # regenerates the types from contracts/openapi
```

`pnpm` and `uv` live in `~/.local/bin` — the Makefile already fixes the PATH.

## The dependency rule — non-negotiable

Dependencies point **inwards**:

```
presentation  →  application  →  domain
infrastructure ─implements→ ports (in application/)
```

- `domain/` is pure code: no framework, no I/O, no clock, no `@nestjs`, no
  `fastapi`, no database client.
- `application/` talks only to **ports** (interfaces / `Protocol`), never to
  adapters.
- The wiring (`*.module.ts`, `container.py`) is the only place that knows all
  three layers.
- No service imports another service's domain. Use contracts.

`make arch` fails on a violation. CI goes further: it introduces a violation on
purpose and fails if the rule does not catch it.

## Where things go

| You are writing                        | It goes in                           |
| -------------------------------------- | ------------------------------------ |
| A pure business rule                   | `domain/`                            |
| Orchestration of a use case            | `application/use-cases/`             |
| An interface to an external dependency | `application/ports.ts` or `ports.py` |
| A database, HTTP or provider client    | `infrastructure/`                    |
| A controller, SSE, queue consumer      | `presentation/`                      |
| Behaviour used by several services     | `packages/` or `python/`             |
| A console screen or a BFF route        | `apps/web/src/app/`                  |

If something is useful to two services, it is a shared library — do not copy it.

## Shared libraries

| TypeScript        | Python           | What                                                   |
| ----------------- | ---------------- | ------------------------------------------------------ |
| `@aia/errors`     | `aia_errors`     | Problem Details (RFC 9457), the error code catalogue   |
| `@aia/auth`       | `aia_auth`       | Local JWT with JWKS, Principal, RBAC/ABAC              |
| `@aia/resilience` | `aia_resilience` | Timeout, retry, circuit breaker, bulkhead              |
| `@aia/telemetry`  | `aia_telemetry`  | OTel with `gen_ai.*` and `aia.*`                       |
| `@aia/messaging`  | `aia_messaging`  | CloudEvents, outbox, Redis Streams                     |
| `@aia/contracts`  | `aia_contracts`  | Types generated from `contracts/`, the data-zone table |
| `@aia/nest`       | —                | HTTP glue for Nest: filter, guard, health              |
| —                 | `aia_fastapi`    | HTTP glue for FastAPI: the same three                  |
| `@aia/sdk`        | `aia_sdk`        | Client for the canonical API, and a fake of it         |

**Never reinvent retry, timeout or circuit breaker.** Use `POLICIES` from
`@aia/resilience`; the values come from the table in reference doc 02 §8.

## Patterns that hold everywhere

**Errors**: a typed domain exception, with a stable code from the catalogue.
Never return `null` to signal an error, never swallow an exception. An unknown
error becomes a 500 with no detail — the internal message goes to the log only.

**Tenant**: `project_id` is required on every contract, event, trace and
partition key. A route that does not operate on a project declares `@NoProject()`.

**Configuration**: validated at boot with zod or pydantic-settings. The
application **does not start** on invalid configuration.

**Secrets**: never in code, never in a committed variable. A missing provider key
disables that provider; it does not bring the service down.

**Telemetry**: every span carries `aia.project_id`. A model call carries
`gen_ai.*`. Prompt content only with project opt-in, and only after redaction.

**Tests**: fakes, not mocks. A test verifies behaviour, not a sequence of calls.
**Every error path has a test** — the happy path is the easiest and the least
informative.

## Language

Code, comments, documentation and commit messages are in **English**. The
exceptions are deliberate and few: the prompt-injection patterns in
`apps/guardrails` and the adversarial payloads in `evals/redteam/` stay in
Portuguese, because an attempt arrives in whatever language the user writes; and
`docs/reference/` holds the original architecture documents, kept unaltered as
the source this work started from.

## Comments

Explain **why**, never **what**. The code already says what.

```ts
// Bad:  increments the reservation counter
// Good: a Lua script, because between the read and the write another replica
//       would read the same balance
```

Comment a non-obvious decision, an accepted trade-off, and the reason a strange
approach is the right one. If the decision is structural, its place is an ADR.

## Naming conventions

- Service: `aia-<name>` in kebab-case. TS package: `@aia/<name>`. Python:
  `aia_<name>`.
- Use case: a verb (`CreateChatCompletion`). Entity: a noun
  (`BudgetReservation`).
- Event: `aia.<domain>.<fact>.v<N>` — a breaking change creates a new type.
- Error code: stable `snake_case`, in the `@aia/errors` catalogue.

## Contracts

Contract-first. The YAML under `contracts/openapi/` is the source; the types are
generated. CI fails if they diverge. Changed the API? Change the contract first.

## The console

`apps/web` is Next.js and follows the same layering, with one difference the
framework forces: its presentation layer is `src/app/`, because the App Router
requires that path. A dedicated dependency-cruiser rule keeps pages and route
handlers from reaching an adapter directly — they go through `container.ts` like
everything else.

Reads are Server Components calling use cases. Writes are Server Actions.
Streaming is the one thing that needs a route handler, because an action returns
once. The platform token lives in an httpOnly cookie and is attached
server-side; nothing in the browser ever holds it.

Imports inside `apps/web` carry no `.js` suffix, unlike the services: Next
resolves with `Bundler`, where the suffix is not rewritten.

## A new service

```bash
node tools/generators/new-service.mjs --name my-service --runtime node --port 3010
```

It produces the right skeleton by construction. Do not copy an existing service.

## Before opening a PR

- `make check` passes
- The contract is updated if the API changed
- Error paths are covered
- An ADR is created or updated if the decision is structural
- Conventional Commits

## Context

`docs/reference/` holds the original architecture documents, which assume Azure.
This implementation is cloud-agnostic — wherever we diverge, the corresponding
ADR explains what and why. Read `docs/adr/README.md` before proposing a
structural change.

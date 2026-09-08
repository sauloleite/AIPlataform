# ADR-025: tool arguments are validated against their schema at the gateway

- **Status**: accepted
- **Date**: 2026-09-08

## Context

`aia-registry` validates a tool's `parameters` when a version is **published**:
`definition-validators.ts` refuses a function tool whose schema is malformed.
`aia-mcp-gateway` then decided who may call the tool, at what risk level, and
whether a person has to approve it — and forwarded whatever arguments arrived,
unread, to the executor.

So the schema was checked once, against nobody's input, and never again against
the input it exists to describe. A model could send a string where an integer
was declared, omit a required field, or add one the tool never mentioned, and
an MCP server or an OpenAPI endpoint would receive it.

This is OWASP LLM05, improper output handling: the model's output is untrusted
input to everything downstream. It is also the gap the published design patterns
against prompt injection explicitly do not cover. Beurer-Kellner et al. stop
untrusted content from **selecting** an action; a later analysis of that work
notes the patterns say nothing about what the selected action **carries** — a
recipient, a URL, a body. Argument validation is that half, and no pattern
substitutes for it.

## Decision

**The gateway validates arguments against the tool's declared schema before
dispatch**, and refuses with a typed `tool_arguments_invalid` (400).

Three details are the decision, not the implementation.

**Where it sits.** After the authorisation decision, before the rate limiter and
before approval. The rate limiter is already placed after the decision so a
refused call does not spend somebody else's allowance; a malformed call has the
same claim. Approval matters more: the scarcest resource this control has is a
person, and asking one to authorise arguments that cannot run spends it for
nothing.

**A schema that will not compile is a refusal.** Ajv failing to compile a tool's
own schema returns a validation failure, not a pass. The alternative makes a
tool published with a broken schema the one tool nobody checks, which is
precisely the tool worth attacking.

**A tool with no `parameters` is not validated.** `parameters` is optional in
the registry, and reading "undeclared" as "nothing is allowed" would break every
tool taking free-form input. A tool that wants this protection declares a
schema — which the registry already validates at publish time.

Ajv lives in `infrastructure/` behind a `SchemaValidator` port, and `ajv` joins
`FRAMEWORK_PACKAGES` in `.dependency-cruiser.cjs` so the rule proves it. The
rule about arguments is the gateway's; the dialect that evaluates JSON Schema is
an adapter's.

## Alternatives considered

| Alternative                                              | Why not                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validate in `aia-agent-runtime`, before the call is made | The runtime is one caller. The gateway is the boundary every caller crosses, and a control that only one client honours is advice.                                               |
| Validate in each executor                                | Three executors, three implementations, and a fourth tool type arrives unvalidated. The check belongs where the decision to dispatch is made.                                    |
| Let the tool's own endpoint reject bad arguments         | It usually will — after receiving them. For an MCP server or a third-party API, "the request was made" is already the damage.                                                    |
| Zod, which the service already depends on                | Zod validates Zod schemas. `parameters` is JSON Schema, written by whoever published the tool, and converting between the two loses exactly the keywords a stricter schema uses. |
| Strip unknown fields instead of refusing                 | Silently changing what the model asked for hides the injection rather than reporting it, and the audit record would show a call nobody made.                                     |

## Consequences

- A tool whose schema is stricter than its callers realised now fails where it
  used to pass. That is the point, and it will surface real bugs on adoption.
- Every failure reason is returned, not the first: the caller is usually a model
  that can correct itself, and one reason per turn costs a turn per field. The
  reasons describe the schema, never the value, so an argument carrying a secret
  is not echoed back.
- Compiled schemas are cached per schema object, including the failures, so a
  broken schema is not recompiled on every call.
- `useDefaults` is on, so a declared default reaches the executor. That means
  validation can **add** fields — deliberate, and the reason the audit record is
  written after the executor returns rather than from the raw command.

## Review

Revisit if tool schemas start arriving in a dialect Ajv cannot evaluate, or if
the platform gains a tool type whose arguments are not JSON at all.

# ADR-027: the data-zone rule has one source, and both languages generate from it

- **Status**: accepted
- **Date**: 2026-09-08

## Context

ADR-010 is the decision this platform is built on: a project's data
classification decides which data zones its content may reach, and a
`restricted` project's content never leaves the machine. It is what the README
means by "sensitive data does not leave here", and what an auditor is shown.

That rule was written out **four times**, as four independent literals:

- `packages/auth/src/authorization.ts`, where the router's ABAC check reads it;
- `python/aia_auth`, where the Python services read it;
- `apps/governance/.../data-classification.ts`, which DECIDES a project's zones;
- `apps/web/.../console/domain/classification.ts`, which SHOWS them.

They agreed. Nothing made them agree, and nothing compared them. The failure
mode is not that a copy is obviously wrong — it is that one of them is edited
and the others are not, and the platform then grants in one place what it
refuses in another. Governance widening a project's zones while the router still
refuses reads as a router bug. The router widening while governance does not is
worse, and looks like nothing at all.

`contracts/openapi/_shared.yaml` already declared both halves of the rule —
`DataClassification` and `DataZone` as enums — and not the mapping between them.

## Decision

**The mapping lives in the contract, as `x-max-data-zones` on
`DataClassification`, and `make contracts` generates it into both languages.**

`openapi-typescript` emits types; this is a runtime value, so the generator
gained a small emitter of its own that writes
`packages/contracts/src/generated/data-zones.ts` and
`python/aia_contracts/src/aia_contracts/_generated/data_zones.py`. The four
copies now read one of those two. CI regenerates and fails on a diff in either.

It goes in the contract rather than in `packages/auth` because it is a fact
about the platform's interface, not about one language's authorisation library —
and because a rule held in one language's package cannot be the source for the
other, which is the whole problem.

This is also the first artefact of the Python contracts track, which existed
only as a placeholder docstring.

A generated diff proves the two outputs came from one source. It does not prove
the generator is right, so `python/aia_contracts/tests/test_data_zones.py`
parses the emitted TypeScript and compares it to the Python, asserts the rule
itself (`restricted` reaches only `local`; each step up in sensitivity narrows
the list, never widens it), and refuses an entry naming a zone that is not
declared.

## Alternatives considered

| Alternative                                                               | Why not                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One language owns it and the other imports over HTTP                      | Turns a compile-time fact into a runtime dependency, and makes the rule unavailable while governance is down — exactly when a fail-closed decision matters most. |
| `packages/auth` owns it, Python duplicates with a CI check comparing them | Keeps two sources and adds a checker. The check would be real, but the second copy would still be edited by hand, and a rule with two authors has no author.     |
| Leave four copies and add a CI check comparing all four                   | Same objection, four times over. It also leaves each service free to "fix" its own copy locally.                                                                 |
| A shared JSON file, read at runtime by both                               | No types on either side, and a typo becomes a runtime failure in a code path that is supposed to fail closed.                                                    |

## Consequences

- Changing the rule is a contract change, which is the correct weight for it:
  contract first, then `make contracts`, then a commit CI verifies.
- `packages/auth` and `apps/web` gain a dependency on `@aia/contracts`, and
  `python/aia_auth` on `aia_contracts`. Both are library-to-library and neither
  reaches a service, so the dependency rules are unaffected.
- `aia_contracts` stops being a placeholder and becomes a real package with
  tests.
- **`DATA_ZONES` — the plain list of zone names — is deliberately left
  duplicated** in three services' value objects. It is a vocabulary, not a rule,
  and the two failure modes are not comparable: a service missing a zone the
  contract added fails to compile the moment the generated table references it,
  which is loud. Collapsing it would make three domains depend on a package for
  a five-element list. Revisit if a zone is ever removed rather than added,
  which the compiler would not catch.

## Review

Revisit if a second contract-level rule needs the same treatment, at which point
the emitter should become general rather than gaining a second special case.

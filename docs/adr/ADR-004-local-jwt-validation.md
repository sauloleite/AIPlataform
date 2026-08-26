# ADR-004: Local JWT validation with JWKS

- **Status**: accepted
- **Date**: 2026-08-25

## Context

Finding 3.2 of reference doc 01: every service called `/auth/validate` before any
useful work. That adds latency to every request, multiplies load on the central
service and turns it into an AVAILABILITY bottleneck — if it goes down, nobody
authenticates.

A JWT is signed. The signature can be verified with the public key, without
asking anyone anything.

## Decision

- `@aia/auth` (TypeScript) and `aia_auth` (Python) validate the JWT locally, with
  the JWKS cached.
- `aia-identity` publishes `/.well-known/jwks.json`.
- **The signing key is persisted**, not generated in memory: an ephemeral key
  invalidates every issued token on each restart and additionally leaves the
  other services holding a stale JWKS in cache, producing 401s with no apparent
  cause. In production the key comes from configuration; in development it is
  generated once and stored in MongoDB.
- An opaque token (PAT) needs introspection, with a 60 s cache.
- **Service to service** uses the `client_credentials` grant: identity itself
  issues the credential. With no cloud providing managed identity, this is how
  one service proves who it is to another.

## Alternatives considered

| Alternative                      | Why not                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introspection for every token    | That is the problem this ADR solves.                                                                                                                          |
| A shared secret between services | A single secret that leaks compromises everything, and rotating it requires restarting all of them at once.                                                   |
| mTLS between services            | It solves service authentication but carries neither scope nor user identity, and running a PKI is disproportionate here. It remains valid as an extra layer. |

## Consequences

**Easier**: an authenticated request generates no extra network call. Identity
can restart without bringing the platform down.

**Harder**: revoking a JWT before it expires is not immediate. The mitigation is
a short TTL (1 h by default) and immediate revocation for PATs.

**Needs attention**: key rotation has to keep the old key in the JWKS until the
tokens signed with it expire. The Python verifier reloads the JWKS when it meets
an unknown signature, so rotation does not break anything.

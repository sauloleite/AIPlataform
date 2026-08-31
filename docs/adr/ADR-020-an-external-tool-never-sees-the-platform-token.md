# ADR-020: an external tool never sees the platform token

- **Status**: accepted
- **Date**: 2026-08-29

## Context

`aia-mcp-gateway` calls tools on the caller's behalf. ADR-017 established that a
cross-service read carries the CALLER's token rather than a service credential,
and the first implementation applied that uniformly: every executor sent
`Authorization: Bearer <the user's platform JWT>`.

For the `file_search` built-in that is exactly right — it reaches
`aia-knowledge`, which authorises the person and trims the search to what they
may read.

For an MCP server or an OpenAPI endpoint it is a credential leak. That token is
a valid AIA JWT with the user's memberships in it. A third party holding one can
call the platform back and read that user's projects, run their tools and spend
their budget. Nothing in the platform would notice: every request would be
correctly signed, correctly authorised, and made by someone else.

ADR-017 answered "which identity" and the answer was right. It did not ask "and
who is on the other end", and that is the question this one answers.

## Decision

**A tool endpoint the platform does not own is authenticated by its
`Connection`, never by the caller's token.**

- A `Connection` is a named credential: `kind` (bearer, api_key, basic, none),
  the header to present it in, and a **reference** to a secret — never the
  secret. It follows ADR-015: the value lives in a file under `/run/secrets` or
  in an `AIA_SECRET_*` variable, and is read at the moment of the call.
- `ToolInvocation.credential` carries the resolved credential for that one call.
  `ToolInvocation.accessToken` stays, documented as usable only by a built-in
  reaching another AIA service.
- Who is asking still travels to an external tool — as `X-Project-Id` and in the
  audit record. What no longer travels is a bearer token somebody else can spend.
- A tool whose connection does not resolve **fails before the request goes
  out**, naming the missing secret. Sending it anonymously would come back as a
  401 the model then has to interpret, when the real fault is a secret nobody
  mounted.

## Alternatives considered

| Alternative                                        | Why not                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mint a short-lived, narrowly scoped token per tool | Better than the leak and worse than a connection: it still hands a third party something that opens a door here, only a smaller one for a shorter time. |
| Send no credential at all to external tools        | Then only public endpoints work, and everyone routes around the gateway.                                                                                |
| Keep the token, and trust the allow-list           | The allow-list says which tools may run, not who may hold a platform identity. An allowed tool can still be a compromised one.                          |
| Store the secret in the connection document        | ADR-015 forbids it, and a database dump would then be a credential dump. The reference is what makes the collection safe to back up.                    |

## Consequences

- `contracts/openapi/mcp-gateway.v1.yaml` gains `/v1/connections`. Neither the
  request nor the response has a field for a secret value — the console
  therefore cannot send one, which is stronger than asking it not to.
- `secret_ref` is constrained to a NAME (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`),
  because the file resolver reads it under a directory: a reference with a
  separator in it is a path traversal, and the signing key is in the same
  container. It is validated on the entity AND again in the resolver, the last
  place before the syscall.
- The console shows whether each connection currently resolves. An operator
  seeing `missing` fixes it before a user meets a tool that fails for a reason
  the error message cannot explain.
- Existing MCP and OpenAPI tools that relied on the platform token stop working
  until a connection is attached. That is the point.

# ADR-017: cross-service references are resolved with the caller's identity

- **Status**: accepted
- **Date**: 2026-08-27

## Context

`aia-registry` validates every reference an agent definition makes when the
agent is published: the model alias has to exist, and so does each vector
store. The first implementation asked those questions with the registry's own
service credential.

The inference-router refused it. `POLICY.READ_PROJECT` is `isMemberOfProject`,
and a service principal is a member of no project — correctly, because the
alternative is a service that can read every project on the platform.

## Decision

**Cross-service reads made on behalf of a user carry that user's token**, not a
service credential. The registry forwards the caller's bearer token when it
asks the router about an alias and knowledge about a store; `aia-knowledge`
does the same when it calls the router for embeddings.

Service credentials remain for genuinely service-initiated work, where there is
no user to act for.

## Alternatives considered

| Alternative                                      | Why not                                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Give the registry a cross-project read scope     | It grants a service permanent read access to every project so that it can answer a question about one. The blast radius of a compromised registry token becomes the whole platform. |
| Make the service a member of every project       | The same power, expressed less visibly.                                                                                                                                             |
| Skip the validation when the service cannot read | Fails open: an agent would publish with a reference that resolves to nothing and fail at its first run instead.                                                                     |

## Consequences

**Easier**: "does this alias exist" is really "may this project use it", which
is a question about the caller. Asking it as the caller gives the right answer
by construction, and the audit trail names a person rather than a service.

**Harder**: a use case that resolves references needs the token threaded
through its command. That is visible in the signature, which is the point —
`PublishVersionCommand` carries `accessToken`, so it is obvious that publishing
acts for somebody.

**Ingestion inherits it too**: embeddings during ingestion are charged to the
project whose user uploaded the document, and the router's budget reservation,
data-classification routing and audit apply exactly as they do to chat.

## Review trigger

A genuinely autonomous flow — a scheduled reindex with no user behind it —
needs a different answer. It should get a narrowly scoped service credential
for that one operation, not a broad one for all of them.

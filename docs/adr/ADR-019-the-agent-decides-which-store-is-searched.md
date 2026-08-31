# ADR-019: the agent's attachment decides which vector store is searched

- **Status**: accepted
- **Date**: 2026-08-29

## Context

The `file_search` built-in retrieves from a vector store owned by
`aia-knowledge`. It needs to know which one.

The first implementation took `store_id` from the tool call's arguments — that
is, from the model. It failed immediately for a boring reason (the model did
not supply one), and the fix exposed a worse problem than the bug.

ADR-006 puts the tenant filter inside the vector search itself, so a store
belonging to another project can never be reached. But an agent naming a store
**inside its own project** passes that filter untouched: the tenant is the same.
A project's HR store and its support store are both `project_id = X`.

So if the model picks the store, the boundary is the model's judgement.

## Decision

**An agent may only search the stores its published definition attaches**
(`AgentDefinition.knowledge`). The runtime binds `store_id` before the call
leaves it:

- one store attached — it is supplied, and `store_id` is not even declared to
  the model;
- several attached — they are declared as an `enum`, so the schema itself
  cannot express a store that is not attached;
- a store outside the set — the call is **blocked before it is sent**, and the
  refusal goes back to the model as that call's result;
- none attached — likewise blocked, with a message saying so.

The blocking happens when the call is resolved, not when it is executed, so a
call held for human approval is already bound to the store it was shown with.

## Alternatives considered

| Alternative                                         | Why not                                                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the model choose, and rely on the tenant filter | The tenant filter does not separate two stores in the same project. This is exactly the confused-deputy shape: the agent has the caller's token and would use it for a store nobody granted it. |
| Put the store id in the tool asset's definition     | Then the store is a property of the TOOL, and every agent sharing `file_search` searches the same store. The attachment belongs to the agent.                                                   |
| Name the store in the agent's instructions          | Prompt text is not an authorisation boundary. It is also the first thing an injected instruction tries to overwrite.                                                                            |
| Silently fall back to an attached store             | It answers a question about documents nobody asked about, and looks like a correct answer. A refusal the model can read is more honest.                                                         |

## Consequences

- `EffectiveTool` in `contracts/openapi/mcp-gateway.v1.yaml` gains `builtin_id`.
  A caller has to know a tool is `file_search` to supply what it must not let
  the model supply.
- The rule is pure and lives in `domain/conversation.py` (`bind_store`), so it
  is tested without a database, a model or a network.
- A blocked call never reaches a human for approval: nothing that will not run
  is worth interrupting somebody for.

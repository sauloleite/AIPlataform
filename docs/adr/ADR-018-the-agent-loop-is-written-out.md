# ADR-018: the agent loop is written out, not delegated to a graph framework

- **Status**: accepted
- **Date**: 2026-08-29

## Context

`aia-agent-runtime` has to run an agent: call the model, execute the tool calls
it asks for, feed the results back, stop when there is an answer, and hold the
whole thing on a durable checkpoint while a human decides whether a high-risk
call may run (flow 7.2 of reference doc 02).

LangGraph is the obvious candidate and was named in the plan this work follows.
It offers exactly those pieces: a state graph, conditional edges, and a
checkpointer with a MongoDB saver.

The platform, however, already owns three of the four. `RunState` is the state.
The `Checkpointer` port is persistence, and `MongoCheckpointer` implements it.
`ApprovalPolicy` is the branch. What was missing was the loop itself — which,
written out, is one `while`, one `if`, and about eighty lines.

## Decision

**The loop is written out in `application/use_cases/run_agent.py`.** No graph
framework.

Adopting LangGraph would have meant wrapping its checkpointer to satisfy the
port that already exists, translating between its message objects and the
`ChatMessageInput` shape the router contract defines, and carrying
`langgraph` plus `langchain-core` and their transitive dependencies for an
abstraction the service immediately hides again behind its own ports.

That is the abstraction paying rent backwards: the framework would be adapted to
the architecture rather than doing work for it.

## Alternatives considered

| Alternative                                         | Why not                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LangGraph with its own `MongoDBSaver`               | Two checkpointers in one service — the framework's and the port's — with the run's status in one and its state in the other. Reconciling them after a crash is harder than the loop they were meant to simplify.                    |
| LangGraph behind the existing `Checkpointer` port   | Possible, and the port is designed for it. But then the framework contributes a graph API for a graph with two nodes, in exchange for a large dependency tree. YAGNI, and doc 01 finding 3.12 removed services for the same reason. |
| A generic agent SDK (`openai-agents`, `smolagents`) | Each brings its own idea of tool authorisation, and this platform's whole point is that authorisation lives in `aia-mcp-gateway` with an allow-list, a risk level and a human in the path.                                          |

## Consequences

- The loop is readable in one file, and every branch in it is covered by a test
  that names the failure it prevents.
- Nothing translates between two notions of a message, so what the model is sent
  is exactly what the router contract publishes.
- **If the shape ever stops being a loop** — parallel branches, sub-agents, a
  planner that revises its own plan — this decision should be revisited. The
  `Checkpointer` and `ModelClient` ports are what keep that a contained change:
  a graph framework would slot in behind them without touching the presentation
  or the domain.
- The step ceiling (`AGENT_MAX_STEPS`) is ours to enforce, because there is no
  framework recursion limit doing it. `LoopPolicy` is that rule, and it warns
  the model one step early so a run ends with an answer rather than with a
  limit the user has to interpret.

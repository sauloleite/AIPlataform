# ADR-029: an evaluator comes from error analysis, never from imagination

- **Status**: accepted
- **Date**: 2026-09-09

## Context

This service shipped with six evaluators. Every one of them was written by
somebody reasoning about what an AI platform probably gets wrong: groundedness,
relevance, safety, exact match, cost, latency. They are not bad guesses. But
nothing in the repository can say which of them ever caught a real defect, and
the ones nobody thought of are by definition absent.

That is the wrong order, and it is expensive in a particular way: an evaluator
measures what its author imagined, the suite goes green, and the failure mode
the platform actually has — a tool called with the right name and the wrong
argument, an answer that quotes the retrieved passage and answers a different
question, a refusal that is technically grounded and useless — is not in the
suite because it was not in anybody's head.

The two things that would have told us are cheap and were both missing: nobody
could see what a call said, and nowhere recorded what a person thought of it.

## Decision

**An evaluator is written after the failure it measures has been seen in a real
trace, named, and counted.** The order is: read traces → annotate what went
wrong → let the taxonomy accumulate → write the evaluator for a mode that keeps
appearing.

What makes that operable rather than a slogan:

| Piece                             | What it is for                                                               |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/completions/{requestId}` | Seeing what a call said at all. The audit existed and nothing could read it. |
| `aia.request_id` on the span      | Getting from a trace to that record                                          |
| `POST /v1/annotations`            | Recording a verdict and, when it is bad, **how** it was bad                  |
| The normalised failure mode       | So one failure written three ways is one entry rather than three anecdotes   |
| The counts on every read          | A mode seen once is an anecdote; one in a third of annotated traces is next  |
| `evaluation labels`               | The same reading becomes the label set a judge is calibrated on (ADR-028)    |

- **The failure mode is free text, normalised, never an enum.** An enum decided
  before the traces were read is the same guess in a different place. The
  taxonomy in the console is whatever the traces produced, and its shape is the
  finding.
- **A bad verdict without a reason is refused.** "It was wrong" is the
  annotation everybody writes when the field is optional and nobody can act on
  afterwards.
- **One person re-annotating a trace replaces their earlier verdict; two people
  annotating it stay two.** The first is somebody changing their mind and would
  inflate a mode by however often its reader hesitated. The second is
  inter-annotator disagreement, which is signal.
- **The seed label set is labelled `seed` and says so.** It was written
  alongside ADR-028 rather than collected, and it is a starting point for
  calibrating a judge, not evidence about this platform's traffic.

## Alternatives considered

| Alternative                                         | Why not                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Keep writing evaluators from first principles       | It is how the current six happened. They may be right; nothing can say, and the modes nobody imagined stay invisible.      |
| A fixed taxonomy of failure modes, decided up front | Same guess, now with the authority of an enum. A taxonomy that cannot grow describes its author.                           |
| Free text with no normalisation                     | "Wrong number", "wrong number" and "Wrong Number" become three findings of one each, and the counts stop meaning anything. |
| Annotate in a spreadsheet                           | It works exactly until somebody needs the annotation next to the trace, or a label set out of it, or a count by mode.      |
| Score everything automatically and skip the reading | An automatic score can only measure a mode somebody already thought of. That is the problem, not the solution.             |

## Consequences

- A new evaluator now needs an argument: which failure mode, seen how often, in
  which traces. That is a deliberate friction and the whole point.
- The console needs somebody to actually read traces. No tool fixes that, and a
  team that does not do it will have an empty taxonomy and honest suites rather
  than a full suite and false confidence.
- Annotations hold a principal id and may quote conversation content, so they
  are in the LGPD inventory with their own erasure step — including the part a
  database cannot reach, a label already exported into a committed file.
- The existing six evaluators stay. This decision is about what gets written
  next, not a reason to delete measurements that are running.

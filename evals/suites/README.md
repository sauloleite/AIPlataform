# Suites

A suite defines WHAT to measure and WHERE the failing threshold sits.

```yaml
name: rag-credit
dataset: ../datasets/credit.jsonl
alias: chat-local # local by default: evaluating should not be expensive
project: platform-ci
evaluators:
  - groundedness: { threshold: 0.80 } # does the answer hold up against the context?
  - relevance: { threshold: 0.75 }
  - safety: { threshold: 1.00 } # this one allows no slack
  - cost_per_answer: { max_micros: 5000 }
  - latency_p95: { max_ms: 3000 }
```

`safety` with a threshold of 1.00 is deliberate: quality tolerates variation, a
leak does not.

The runner arrives in phase 2 (`aia-evaluation`). Until then, the suites act as
the specification of what will be measured.

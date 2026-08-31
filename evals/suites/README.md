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

## Running one

```bash
make eval                                    # every suite in this directory
uv run python -m evaluation.cli run --dry-run   # validates without spending
```

The exit code is the gate: **1** when a suite fell below a threshold, **2** when
a run did not measure what it claimed. Those are different problems. The first
is quality regressing and the prompts are the place to look; the second is a
case that fell over or a judged evaluator with no judge, and looking at prompts
would waste a morning.

## The judge

`groundedness` and `relevance` are scored by a model. `JUDGE_ALIAS` says which
one, and it should NOT be the alias under test — a model asked to grade its own
answer agrees with itself. The runner warns when they match.

Left empty, a suite naming a judged evaluator **refuses to run**. That is
deliberate: a suite that quietly skipped its groundedness evaluator would report
a pass, and a pass nobody measured is worse than no evaluation at all.

## What is refused rather than measured

| Situation                           | What happens                                                              |
| ----------------------------------- | ------------------------------------------------------------------------- |
| An evaluator name nobody implements | Refused when the file is READ, before any inference                       |
| A judged evaluator with no judge    | The run errors, and not one case is answered                              |
| Fewer cases than `min_cases`        | Refused — trimming the dataset is the easiest way to improve a number     |
| A case that errored                 | The whole run is `errored`, never averaged over the survivors             |
| An evaluator that scored nothing    | Fails. `mean([])` is 0.0, which reads as a comfortable pass for a ceiling |

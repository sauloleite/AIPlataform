# ADR-021: an evaluation refuses rather than scoring nothing

- **Status**: accepted
- **Date**: 2026-08-29

## Context

Reference doc 02, principle 10: quality measured, not assumed. `aia-evaluation`
turns that into a number and a gate — a suite that falls below its threshold
stops a merge.

A gate is only worth having if it can fail. The failure mode of an evaluation
system is not a wrong score; it is a **green run that measured nothing**. A
judged evaluator with no judge configured, a case that errored and got averaged
out, a dataset somebody trimmed, an evaluator name with a typo in it — every one
of those produces a pass, and a pass reads as evidence.

That is worse than having no evaluation at all, because somebody acted on it.

## Decision

**Anything that would report a verdict it did not measure is refused, loudly,
as early as possible.**

| Situation                                  | What happens                                     | Why not the obvious alternative                                                                |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| An evaluator name nobody implements        | Refused when the suite file is READ              | Discovering it mid-run has already spent money, and skipping it silently drops a metric        |
| A judged evaluator with no judge           | The run errors, and **not one case is answered** | Scoring 0 blames the model; scoring 1 is a lie; skipping it reports a pass                     |
| A judge that answered something unreadable | The case errors                                  | 0.0 is indistinguishable from the judge genuinely saying 0.0                                   |
| A case that errored                        | The whole run is `errored`                       | Averaging over the survivors reports a good score for a broken run                             |
| Fewer cases than `min_cases`               | Refused before anything runs                     | Trimming the dataset is the easiest way to improve a number                                    |
| An evaluator that scored no cases          | Fails, whatever the value                        | `mean([]) == 0.0`, which reads as a real zero for a floor and a comfortable pass for a ceiling |

**`failed` and `errored` are different states, and stay different.** `failed` is
quality below a threshold: look at the prompts. `errored` is a measurement that
did not happen: look at the wiring. Both stop a merge — the CLI exits 1 and 2
respectively, and the HTTP endpoint answers 409 for either — but collapsing them
into "red" sends half the people to the wrong place.

**The judge is a separate port from the target**, so it can be a different
alias. A model asked to grade its own answer agrees with itself. It is not
forbidden — a small team may genuinely have one alias — but the runner warns
when they match, because the resulting score looks exactly like a real one.

## Alternatives considered

| Alternative                                          | Why not                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Default a missing evaluator to a neutral score       | There is no neutral score. Any number reported for something nobody measured is fabricated.                         |
| Skip evaluators that cannot run, and report the rest | The suite then measures a moving target, and the metric that disappeared is the one somebody removed the judge for. |
| Treat an errored case as a zero                      | It punishes the model for the platform's outage, and the fix goes in the wrong place.                               |
| Ship without a gate and just record scores           | Nobody reads a dashboard during a merge. A number that does not block is a number that drifts.                      |

## Consequences

- Getting a green run requires the wiring to be right, which is the point and
  is occasionally annoying. `--dry-run` validates every suite without spending
  a token, so the annoying part is cheap.
- `JUDGE_ALIAS` is **empty by default**. Out of the box, a suite naming
  `groundedness` refuses to run. That is deliberate: an operator who has not
  chosen a judge has not chosen one, and the platform should say so rather than
  pick.
- An offline batch gets a longer inference ceiling than an interactive call
  (`EVALUATION_INFERENCE`, five minutes rather than sixty seconds). Same retry
  and same circuit breaker; the only change is the timeout, because nobody is
  waiting. It is a named policy rather than a hand-rolled timeout, so it is
  visible in one place.
- The thresholds in `evals/suites/` are the **floor of what has been measured**,
  not an aspiration. An impossible threshold gets switched off in the first
  week, and a gate that is off is a gate that is not there.

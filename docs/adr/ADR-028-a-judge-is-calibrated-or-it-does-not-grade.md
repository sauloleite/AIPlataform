# ADR-028: a judge is calibrated, or it does not grade

- **Status**: accepted
- **Date**: 2026-09-09

## Context

ADR-021 refuses to report a verdict the platform did not measure. It closed
every hole where a number appears without a measurement behind it — a missing
judge, an errored case averaged away, a trimmed dataset.

It left the one above all of them. `groundedness: 0.87` is produced by asking a
model what it thinks, and **nothing checked whether that model's opinion tracks
a human's**. The number reads identically whether the judge distinguishes a
grounded answer from an invented one or simply likes fluent paragraphs, and both
of them stop merges with equal confidence.

Three failure modes make this concrete, and none of them looks like a failure:

- **Agreeing by chance.** On a label set that is 90% good answers, a judge that
  answers 1.0 to everything agrees with the humans 90% of the time. Raw
  agreement reports an excellent judge for having no opinion.
- **Systematic generosity.** A suite thresholds the _mean_ of the judge's
  scores. A judge running 0.15 kinder than the humans turns a declared floor of
  0.8 into a real one of 0.65 — every suite passes more easily than its file
  says, and the file is what anybody reviews.
- **Blindness in the one direction that matters.** A judge can look respectable
  overall while passing most of the answers a human threw out. That is the
  failure that makes a gate decorative.

## Decision

**A judged evaluator does not run until the judge has been measured against
human labels, on a held-out split, and cleared a stated bar.** Failing that, the
run is `errored` — the ADR-021 state that means "the measurement did not
happen", not `failed`, which would send somebody to read prompts.

The measurement:

| Statistic       | What it catches                                     | Default bar |
| --------------- | --------------------------------------------------- | ----------- |
| Held-out labels | A number computed over a handful of opinions        | ≥ 10        |
| Cohen's kappa   | A judge agreeing by chance, or by having no opinion | ≥ 0.4       |
| Signed bias     | A judge that silently moves every suite's threshold | ≤ 0.1       |
| False-pass rate | A judge that waves through what a human rejected    | ≤ 0.25      |

- **Held out means held out.** Half the labels, chosen by a hash of the label's
  own id, are never looked at while a criterion is written. The hash is on the
  id rather than on the position so that adding a label never moves an existing
  one across the split — a split that reshuffled on every append would promote
  cases somebody had already argued with into the half whose whole value is that
  nobody has.
- **The record keeps the pairs, not a summary.** A stored kappa is an assertion;
  a stored list of what the human said next to what the judge said is evidence,
  and it can be recomputed, re-thresholded, and read in a diff.
- **The bar is applied at run time, not frozen into the record.** Raising it
  takes effect on the next run rather than grandfathering every record written
  under the old one.
- **Per evaluator, not per judge.** Telling grounded from invented and telling
  relevant from off-topic are different jobs, and a model can be good at one.
- **The record expires.** Ninety days by default, `0` to disable. An alias is a
  _name_: a provider re-points it at a new snapshot and nothing tells the
  platform. The age is not evidence that the model changed — it is a bound on
  how long the platform grades with a number nobody has rechecked.
- **Where the labels live**: `evals/labels/*.jsonl`, in Git, like the datasets.
  The records land in `evals/calibration/`, also in Git, and are produced by
  `make calibrate`.

## Alternatives considered

| Alternative                                 | Why not                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Report raw agreement with the labels        | It is the statistic that makes an opinionless judge look excellent. Chance correction is the entire point.                                             |
| Warn instead of refusing                    | The same argument ADR-021 already settled: a warning nobody reads next to a number everybody reads.                                                    |
| Calibrate once and trust the record forever | An alias is re-pointed by a deploy and by a provider, neither of which touches this repository.                                                        |
| Compute the statistics over all the labels  | Then the number describes the cases whose disagreements were used to word the criterion, which is the definition of a measurement that proves nothing. |
| Store the calibration in Mongo              | The gate has to work on a laptop and in CI with no database, and a record the graded system can rewrite is not evidence.                               |
| Let the judge grade itself into calibration | It is the self-judging problem ADR-021 already warns about, with the warning removed.                                                                  |

## Consequences

- **Out of the box, a judged suite refuses.** `JUDGE_ALIAS` is empty by default
  (ADR-021), and even with one set there is no calibration record in the
  repository until somebody runs `make calibrate` against a real model. That is
  the honest state: nobody has checked this judge. The refusal names the command.
- Calibration costs one inference per label — about sixty for the seed set. It
  is run when the judge alias changes, not on every push.
- `evals/labels/` ships a seed set written alongside this decision, deliberately
  containing the cases where judges and humans come apart: a refusal ("the
  runbook does not say") that is _grounded_ and _irrelevant_, an answer that is
  relevant and wrong, and true claims that are absent from the context. It is a
  starting point, not annotations from production. The annotation surface over
  real traces replaces it, and that is when these numbers start describing this
  platform's traffic rather than its authors' expectations.
- The per-case decision point is 0.5, while a suite thresholds the mean of many
  scores. The two are not the same question, which is why bias is reported
  beside kappa rather than instead of it.
- A judge that fails the bar still gets its record written. It is exactly the
  record worth reading.

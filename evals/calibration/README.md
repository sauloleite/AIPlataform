# Calibration records

One file per judge alias and evaluator, produced by `make calibrate`, committed
like the datasets. A judged evaluator refuses to run without one (ADR-028).

```
evals/calibration/<judge-alias>.<evaluator>.json
```

Each record holds **every pair the calibration produced** — what the human said
next to what the judge said — split into `held_out` and `development`, plus the
criterion the judge was given and the date it was computed.

The pairs are kept rather than a summary, for three reasons in order of
importance:

1. A stored kappa is an assertion. A stored pair list is evidence, and anybody
   can recompute the number from it.
2. The statistics are computed at run time, so raising the bar takes effect
   immediately rather than grandfathering every record written under the old one.
3. A reviewer reading the diff sees the judge's actual opinions move, which is
   the only way a bad criterion is ever noticed.

## What makes a record stop counting

- A different judge alias — a calibration of one model says nothing about another.
- Ninety days (`JUDGE_CALIBRATION_MAX_AGE_DAYS`, `0` disables it). An alias is a
  name, and a provider re-points a name at a new snapshot without telling
  anybody.
- A criterion edit. Changing the wording in `domain/judging.py` invalidates
  every record here; the criterion is stored in the file so the difference is
  visible.

## There is no record in this directory yet

Nobody has calibrated a judge against a real model in this repository. That is
the honest state, and it is why a judged suite currently refuses to run and says
so. Running `make calibrate` against `platform-ci` with `JUDGE_ALIAS` set is what
changes it.

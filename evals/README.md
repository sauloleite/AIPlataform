# Evaluation (evals)

Quality measured, not assumed (reference doc 02, principle 10).

A prompt that "looks better" is not better: it is an opinion. These suites exist
to turn that into a number, and to make a regression show up in CI rather than in
front of a user.

## Structure

```
evals/
├── datasets/      questions with a reference answer, versioned
├── suites/        what to measure and where the failing threshold sits
├── trajectories/  recorded agent runs, and what each should be true of
└── redteam/       adversarial cases (injection, jailbreak, exfiltration)
```

## When it runs

Two columns, because they are not the same claim. **Today** is what the
repository actually does; **intended** is what `docs/ROADMAP.md` M6 builds. A
table that describes only the intention reads as a guarantee, and a guarantee
nobody implemented is worse than an admitted gap.

| Moment                                | What runs                     | Today                   | Intended (M6)                     |
| ------------------------------------- | ----------------------------- | ----------------------- | --------------------------------- |
| Every pull request                    | Red team                      | **Yes**                 | Yes, if a known case gets through |
| Every pull request                    | Agent trajectories            | **Yes**                 | Yes                               |
| A prompt, alias or chunking change    | The affected use case's suite | Nothing — no CI job     | Yes, below the threshold          |
| Before swapping an alias's deployment | The model regression suite    | Nothing — no such suite | Yes                               |
| Production                            | A 1 to 5% traffic sample      | Nothing — no sampler    | No, it alerts                     |

The two rows marked **Yes** are the ones that cost nothing, and that is why they
are the ones that run per PR. The red-team cases go through
`apps/guardrails/tests/test_redteam_dataset.py` and the trajectory cases through
`apps/evaluation/tests/test_trajectory_dataset.py`; the `test-unit` job executes
both, with no model, no containers and no network.

The split is not a compromise, it is the honest reading of what a gate can
measure. `docker-compose.ci.yml` swaps the model for `tools/mock-provider`,
which answers the literal string `ok` — so a groundedness gate against it would
grade `ok` against a reference answer and report a number that means nothing.
Groundedness needs a judge, a judge needs a real model, and a real model costs
money and time on every push. It belongs to a scheduled run against
`platform-ci`, gating a release rather than a pull request.

`make eval` runs the judged suites locally, and no workflow calls it yet.
`tools/scripts/seed.sh` does create the `platform-ci` project it needs, with its
own budget.

## Why the threshold is not 100%

An impossible threshold gets switched off in the first week. The thresholds here
are the **floor of what has already been measured**, and they rise as the system
improves — never the other way round.

## Cost

Evaluation consumes real inference. Run it against the `platform-ci` project,
which has its own budget, and prefer the local alias (`chat-local`) for suites
that do not depend on a specific provider's quality.

## Current state

The runner is real. `aia-evaluation` loads the suites, answers every case
through `aia-inference-router` with the caller's token, scores them and gates on
the thresholds — `make eval` locally, the same use case behind
`POST /v1/evaluations`.

The agent-specific evaluators are here now, in
`apps/evaluation/src/evaluation/domain/trajectory.py`: tool selection, forbidden
tools, call order, argument correctness, a step budget, loop detection and
recovery from a failing tool. They are pure functions over the shape
`GET /v1/runs/{runId}` returns — read through the CONTRACT, so no service
imports another's domain — which is what lets them score a recorded run with
nothing running.

The runs in `trajectories/` are RECORDED from the real runtime by
`tools/scripts/record-trajectories.py`, never written by hand: a fixture
somebody invented can describe a run the platform never produces, and an
evaluator built on one measures the fixture. One of the four is a deliberate
failure — a run that calls the same tool three times and blows its budget — and
the checks are asserted to catch it, because a suite where everything passes
proves only that the evaluators return true.

What is NOT here yet: online evaluation of a production traffic sample, judge
calibration against human labels, and the scheduled run of the judged suites.

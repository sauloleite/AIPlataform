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
├── labels/        what a human decided, so the judge can be measured
├── calibration/   what the judge decided about those, and how far apart they are
└── redteam/       adversarial cases (injection, jailbreak, exfiltration)
```

## When it runs

Two columns, because they are not the same claim. **Today** is what the
repository actually does; **intended** is what `docs/ROADMAP.md` M6 builds. A
table that describes only the intention reads as a guarantee, and a guarantee
nobody implemented is worse than an admitted gap.

| Moment                                | What runs                        | Today                                  | Intended (M6)                     |
| ------------------------------------- | -------------------------------- | -------------------------------------- | --------------------------------- |
| Every pull request                    | Red team                         | **Yes**                                | Yes, if a known case gets through |
| Every pull request                    | Agent trajectories               | **Yes**                                | Yes                               |
| Push, or a PR labelled `e2e`          | `ci-smoke` (exact match, safety) | **Yes**, with its own negative control | Yes                               |
| A prompt, alias or chunking change    | The affected use case's suite    | Nothing — no CI job                    | Yes, below the threshold          |
| Before swapping an alias's deployment | The model regression suite       | Nothing — no such suite                | Yes                               |
| Production                            | A 1 to 5% traffic sample         | Nothing — no sampler                   | No, it alerts                     |
| Before a judged suite runs, at all    | The judge's own calibration      | **Yes** — it refuses without one       | Yes                               |
| Nightly, and on demand                | The judged suites                | **Yes**, if a provider key is set      | Yes, gating a release             |

The third row is not "every pull request", and the distinction is the honest
one: `ci-smoke` needs a router and guardrails running, so it lives in the `e2e`
job, which is skipped on an unlabelled pull request because it starts six
containers. The two rows above it cost nothing and really do run on every
change.

The first two rows cost nothing, which is why they run per PR. The red-team
cases go through
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

The judged half runs in `.github/workflows/judged-evals.yml`: nightly at 04:17
UTC and on demand, against `platform-ci`, with the alias under test graded by a
different one. It gates a release rather than a merge. Without a provider key
configured it runs nothing and **says so in the run summary** — a scheduled job
that passes green because it could not reach a model is this repository's
favourite failure, one level up. `make eval` runs the same suites locally, and
`tools/scripts/seed.sh` creates the `platform-ci` project they need, with its
own budget.

## The judge is measured too

A judged suite asks a model what it thinks and turns the answer into a gate.
Nothing in that checks whether the model's opinion tracks a human's, and
`groundedness: 0.87` reads the same either way. So a judged evaluator refuses to
run until its judge has been graded against `evals/labels/` on a held-out half
and cleared a bar — ADR-028, and `evals/labels/README.md` for how to produce the
record. There is no record in the repository today, which means a judged suite
currently refuses and says which command fixes it. That is the same refusal
ADR-021 makes everywhere else: better than a number nobody can account for.

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

# Evaluation (evals)

Quality measured, not assumed (reference doc 02, principle 10).

A prompt that "looks better" is not better: it is an opinion. These suites exist
to turn that into a number, and to make a regression show up in CI rather than in
front of a user.

## Structure

```
evals/
├── datasets/   questions with a reference answer, versioned
├── suites/     what to measure and where the failing threshold sits
└── redteam/    adversarial cases (injection, jailbreak, exfiltration)
```

## When it runs

| Moment                                | What runs                     | Blocking?                         |
| ------------------------------------- | ----------------------------- | --------------------------------- |
| A prompt, alias or chunking change    | The affected use case's suite | Yes, below the threshold          |
| Before swapping an alias's deployment | The model regression suite    | Yes                               |
| Weekly and before a release           | Red team                      | Yes, if a known case gets through |
| Production                            | A 1 to 5% traffic sample      | No, it alerts                     |

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

What is NOT here yet: online evaluation of a production traffic sample, and the
agent-specific evaluators (correct tool use, task completion). The offline gate
is the half that stops a regression from merging, and it is the half that is
built.

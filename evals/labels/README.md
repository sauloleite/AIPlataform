# Labels

What a person decided about an answer, so that the judge grading the suites can
be measured against it (ADR-028). A judged evaluator refuses to run until its
judge has cleared the bar on these.

One JSONL file per evaluator. Each line:

```json
{
  "id": "g-001",
  "evaluator": "groundedness",
  "question": "Como reinicio o router com seguranca?",
  "answer": "Drene o trafego antes de reiniciar.",
  "human": 1.0,
  "reference": "Drenar o trafego antes de reiniciar.",
  "context": ["Drain traffic first, then restart."],
  "labelled_by": "seed",
  "note": "why this one is labelled the way it is"
}
```

The whole case travels with the label — question, context, reference — because
the judge has to be asked exactly the way the runner asks it. A label holding
only a score would calibrate a prompt nobody kept.

## Rules

- **`human` is a person's verdict**, on the same 0–1 scale the judge answers on.
  The seed set uses only 0 and 1: a human asked to put a number on "partially
  grounded" invents one, and an invented label calibrates nothing.
- **Half of them are held out**, chosen by a hash of the id. That half is not to
  be read while a criterion is being written — it is the only half whose number
  means anything afterwards. Adding a label never moves an existing one across
  the split.
- **Both halves must contain answers a human rejected.** A label set that grew
  until everything in it is good makes a judge that says yes to everything look
  perfect. `apps/evaluation/tests/test_labels_dataset.py` fails when that
  happens, on every pull request, at no cost.
- **No real PII**, as in the datasets. Synthetic or platform-internal content.
- **An id is never reused**, and never renumbered: an id is what decides which
  half a label is in.

## Where these came from

The files here are a **seed set**, written alongside ADR-028 rather than
collected from production. They are chosen for the cases where a judge and a
human come apart, which is what a calibration set is for:

- a refusal — "the runbook does not say" — which is perfectly _grounded_ and
  entirely _irrelevant_;
- an answer that is relevant and wrong, because relevance is not correctness;
- claims that are true of this platform and absent from the context, which is
  the hardest kind of ungrounded answer to catch and the most common;
- an answer that copies the context correctly and answers a different question.

`labelled_by: "seed"` says exactly that. When the annotation surface over real
traces lands, labels from it carry the annotator, and these numbers start
describing this platform's traffic rather than its authors' expectations.

## Producing a calibration

```bash
make calibrate                 # every evaluator, using JUDGE_ALIAS
```

It grades every label with the judge, writes `evals/calibration/<alias>.<evaluator>.json`,
prints the held-out agreement next to the development agreement — a large gap
between them is the warning that a criterion was tuned until the cases somebody
was reading came out right — and exits non-zero if the judge does not clear the
bar.

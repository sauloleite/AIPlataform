# Red team

Adversarial cases. Two files, and both matter equally:

- `prompt-injection.jsonl`: attacks that must be **blocked**.
- `false-positive.jsonl`: legitimate use that must NOT be blocked.

The second file exists because an aggressive detector is worse than none: it
blocks real work, the team loses confidence and somebody switches the guardrail
off. A guardrail that is off protects nothing.

The `input` payloads stay in Portuguese: an attempt arrives in whatever language
the user writes, and these are the patterns most of this platform's traffic uses.
The metadata around them is in English.

## Run them

The same cases run as domain unit tests, with no cost and no network:

```bash
uv run pytest apps/guardrails/tests/test_redteam_dataset.py -v
```

## When a new case appears

An attack that got through in production becomes a line in
`prompt-injection.jsonl` and a case in the test, in the same PR as the fix.
Without that, the regression comes back.

## The honest limit

Injection heuristics are a partial defence (ADR-014). Real protection comes in
layers: retrieved content marked as data, tool arguments schema-validated, model
output never executed, and human approval for high-risk tools.

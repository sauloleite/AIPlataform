# Datasets

One JSONL file per use case. Each line:

```json
{ "id": "credit-001", "input": "...", "expected": "...", "context": [], "tags": ["credit"] }
```

Rules:

- **Versioned in Git**, so a dataset change shows up in a PR. Improving the
  number by changing the dataset is the easiest way to fool yourself.
- **No real PII**, ever. Use synthetic data; for a CPF, use values that pass the
  check digit but were never assigned.
- A production sample only goes in **anonymised** and with DPO approval.

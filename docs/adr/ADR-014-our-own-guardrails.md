# ADR-014: Our own guardrails with Presidio

- **Status**: accepted (new)
- **Date**: 2026-08-25

## Context

Reference doc 02 uses Azure AI Content Safety with Prompt Shields for content
inspection and prompt injection defence. Without Azure, two distinct problems —
often conflated — have to be solved:

1. **PII redaction** (LGPD, OWASP LLM02): preventing national IDs, cards and bank
   accounts from leaving the platform or being persisted in the clear.
2. **Prompt injection detection** (OWASP LLM01).

The first has a good, deterministic solution. The second does not — and it
matters to be honest about that.

## Decision

An `aia-guardrails` service in Python (the language choice is justified here:
Presidio is Python), with:

- **Presidio** for PII detection, with our own Brazilian recognisers for **CPF,
  CNPJ and bank branch/account**. Each pairs a pattern with **check-digit
  validation**: a regex on its own turns an 11-digit ticket number into a false
  positive, and a detector that erases half the numbers in a text gets switched
  off by the team in the first week.
- **An alternative regex detector**, with no language model, used when the spaCy
  model is unavailable. It covers CPF, CNPJ, card, email, phone and IP; it does
  not cover person names, and that difference is documented.
- **Deliberately conservative injection heuristics**, with a blocking threshold
  at 0.8.

**Decision policy**: PII leads to REDACTION, not blocking — refusing a request
because it contains a national ID would punish the user for data the platform
knows how to handle. Strong injection leads to BLOCKING, because there is no safe
version of the content.

**Failure policy**: if guardrails does not answer, the content GOES THROUGH
unredacted and the fact is recorded. Blocking all inference because of the
guardrail would turn degradation into an outage. What the platform guarantees in
that state is not to PERSIST unredacted content.

## What this does NOT solve

Prompt injection heuristics are a partial defence, and saying otherwise would be
dangerous. Real protection comes in layers, and all of them still apply:
retrieved content is marked as data and never interpreted as instruction, tool
arguments are schema-validated, model output is never executed, a high-risk tool
requires human approval, and least privilege applies per tool.

## Alternatives considered

| Alternative                       | Why not                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Llama Guard as the only guardrail | It costs an extra inference per request and does not locate the PII for redaction. It stays available as an optional adapter. |
| Regex only                        | It detects neither person names nor addresses.                                                                                |
| A managed content safety service  | It ties the platform to one cloud (ADR-012) and sends out exactly the content we are trying to protect.                       |

## Review

Reconsider the injection heuristics after each red team round. If the false
positive rate passes 1% of legitimate traffic, loosen them; if a known attack
gets through, tighten them with evidence.

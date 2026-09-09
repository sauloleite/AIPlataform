# ADR-030: production is sampled, deterministically, and off by default

- **Status**: accepted
- **Date**: 2026-09-09

## Context

A suite measures the platform against questions somebody wrote down. Production
asks different questions, in a distribution that keeps moving, and a suite that
passed last night says nothing about the traffic that arrived this afternoon.
Everything in `evals/` is a rehearsal.

Watching all of it is not an option. Scoring every call with a judge doubles the
inference bill and puts a second model call behind every first one. And the
thing being read is other people's conversations, which is a privacy decision
before it is an engineering one.

## Decision

**A deterministic fraction of completed calls is scored after the fact, by a
worker with no request path, and the whole mechanism is off unless somebody
turns it on.**

- **Deterministic by request id, never random.** `should_sample` hashes the id:
  a redelivered event scores the same call rather than becoming a second sample,
  two replicas agree without coordinating, and "we sample 5%" is a claim anybody
  can verify from a day of traffic. Redis Streams deliver at least once, so
  `random()` here would quietly inflate every count by the retry rate.
- **Off by default** (`ONLINE_SAMPLE_RATE=0`). Sampling spends inference on real
  traffic and reads what real people wrote. That is a decision to make, not one
  to inherit from a default.
- **The worker refuses to start rather than running empty**, naming which of the
  three requirements is missing: a rate, a judge alias, a service credential. A
  sampler that runs and scores nothing produces thin summaries instead of absent
  ones, and nobody goes looking.
- **The judge must be calibrated** (ADR-028). An online score reaches a
  dashboard rather than a gate, which makes an unchecked judge here harder to
  notice, not less dangerous.
- **What cannot be scored is recorded as unscorable, with the reason**, and the
  summary reports that count beside the means. The commonest reason is a project
  that does not capture content; a zero in its place would read as a platform
  producing terrible answers, and dropping it silently would make a measurement
  of a tenth of the traffic look healthy.
- **Relevance only, not groundedness.** A production prompt reaches the audit as
  one redacted string, with no way to tell retrieved passages from instructions.
  Grading groundedness against that would grade the answer against the question
  and report a number for something nobody measured — ADR-021 applied to the
  online path.
- **The sampler acts as itself, with its own client-credentials principal.** It
  consumes a queue, so there is no caller to act as (ADR-017 covers the case
  where there is one). This makes it one of the most privileged components in
  the platform: it reads audit content across every project it samples. Hence
  the empty default, the separate process from the API, and the instruction to
  give it the narrowest identity that can still read a record.
- **The samples hold scores, never content.** What was said stays in the
  router's audit under that project's retention. Copying it into the evaluation
  database would create a second copy with a different expiry, which is how a
  retention policy becomes a fiction.

## Alternatives considered

| Alternative                                     | Why not                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Score every call                                | Doubles the inference bill and makes quality measurement the platform's largest cost centre.                                       |
| Score synchronously, on the request path        | It puts a judge's latency in front of a user, to produce a number the user will never see.                                         |
| Sample randomly                                 | At-least-once delivery turns "5% of calls" into "5% of deliveries", and two replicas disagree about which calls those were.        |
| Sample by time window ("the first 10 per hour") | Biased towards whatever traffic arrives at the top of the hour, which is exactly the traffic that differs.                         |
| Copy the content into the sample                | A second copy of a conversation with a different expiry from the one the project agreed to.                                        |
| Reuse the user's token                          | There is no user: the worker reads a stream. A stored user token would be a permanent credential belonging to whoever last called. |

## Consequences

- Turning sampling on has a bill: one judged call per sampled call, against the
  sampled project's budget. 5% of traffic is 5% more inference.
- The service credential needs a role that can read an audit
  (`project_owner` or `auditor`) in every project it samples, or `platform_admin`
  across them. That is a lot of privilege for a worker, and it is why this ADR
  says so twice.
- A project that does not capture content can be sampled and will produce only
  unscorable samples. That is visible in the summary rather than silent, and the
  fix is a project setting, not a sampler setting.
- Online scores are not a gate. Nothing blocks on them, by design: a merge is
  gated by suites, and production is observed.

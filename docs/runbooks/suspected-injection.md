# Suspected prompt injection or exfiltration

**Trigger**: a rise in `guardrail_blocked` or `prompt_injection_suspected`, or a
report of anomalous agent behaviour.

Treat it as a security incident until proven otherwise. Preserve evidence BEFORE
changing anything.

## 1. Preserve evidence

```bash
# Recent blocks, by project and principal
docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
db.inference_audit.find(
  { errorCode: { $in: ["guardrail_blocked", "prompt_injection_suspected"] },
    occurredAt: { $gte: new Date(Date.now() - 24*3600*1000) } },
  { projectId: 1, principalId: 1, alias: 1, errorCode: 1, occurredAt: 1 }
).sort({ occurredAt: -1 }).limit(50)'
```

Keep the `trace_id` of each occurrence: the full trace shows what the model
received, which deployment served it and which tools were called.

## 2. Classify

- **False positive** (the most common): a legitimate user asking ABOUT prompt
  injection, or text that matched a heuristic. Confirm it against the excerpt
  recorded in the signal.
- **A test** by someone on the team probing the limits.
- **A real attack**: a repeated pattern, coming from a single principal, or
  content retrieved from a document trying to redirect the model.

## 3. Contain (if it is real)

1. **Freeze the tool or the project**, not the whole platform. Disable the alias
   or lower the project's `max_concurrent_requests` through the governance API.
2. **Revoke the PATs** of the principal involved.
3. **If it came from an ingested document** (indirect injection), remove the
   document from the store and check the source: LLM04, data poisoning.

## 4. Investigate

Questions the evidence has to answer:

- Was any tool executed? Under which identity?
- Did the content leave the platform? To which data zone?
- Was there an attempt to exfiltrate through a URL?

```bash
docker compose -f deploy/compose/docker-compose.yml exec -T redis \
  redis-cli XRANGE aia:events:aia.tools.tool.invoked.v1 - + COUNT 100
```

## 5. Afterwards

- If it was a false positive, tune the heuristic in
  `apps/guardrails/src/guardrails/domain/injection.py` **and add a case to the
  false positive test**. Without the test, the regression comes back.
- If it was a real attack, add the payload to `evals/redteam/` so CI starts
  detecting it.
- Review whether the tool involved really needed the scope it had (LLM06).

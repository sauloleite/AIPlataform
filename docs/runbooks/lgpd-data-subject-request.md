# Data subject request (LGPD)

**Trigger**: a request forwarded by the DPO — access, correction, portability or
erasure.

Legal deadline: 15 days for access and portability (LGPD, art. 19).

## What the platform holds about a person

Knowing this up front saves time and avoids an incomplete answer:

| Where                                  | What                                      | Retention                     |
| -------------------------------------- | ----------------------------------------- | ----------------------------- |
| `aia_identity.principals`              | id, email, name, roles                    | as long as the account exists |
| `aia_identity.personal_access_tokens`  | token hash, name, usage                   | 30 days after expiry          |
| `aia_router.inference_audit`           | principal_id, project, tokens, cost, zone | per project, 90 days default  |
| `aia_router.inference_audit` (content) | **redacted** prompt and answer            | only with project opt-in      |
| `aia_agent_runtime.runs`               | principal_id, project, agent, thread      | none — no TTL yet             |
| `aia_agent_runtime.checkpoints`        | the run transcript, keyed by `run_id`     | none — no TTL yet             |
| `aia_mcp_gateway.tool_invocations`     | principalId, tool, arguments hash         | 365 days (TTL)                |
| `aia_evaluation.annotations`           | principal_id, and the answer they read    | none — no TTL yet             |
| Redis Streams                          | events carrying principal_id              | the stream's length cap       |
| Traces                                 | `aia.principal_id`                        | per the backend's retention   |

`aia_router.inference_audit` now expires **per project**: the record carries an
`expiresAt` written from that project's `content_retention_days`, so a project
asking for thirty days gets thirty. Change it through governance:

```bash
curl -X PUT "${BASE_URL}/v1/projects/${PROJECT_ID}/policy" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d '{"content_retention_days": 30}'
```

It applies to records written from then on. Shortening retention does not expire
what is already stored — those documents carry the expiry they were written
with, and this procedure is what removes them sooner.

The two `aia_agent_runtime` collections still have **no TTL** at all: an agent
transcript is kept indefinitely, and this procedure is the only thing that
removes one. `aia_mcp_gateway.tool_invocations` keeps its service-wide 365 days,
which holds no conversation content — only which tool ran, for whom and when.

Conversation content exists only if the project enabled `content_capture`, and
even then it has already been through PII redaction.

## Access and portability

```bash
PRINCIPAL_ID="<id>"
COMPOSE="docker compose -f deploy/compose/docker-compose.yml"

$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  printjson(db.principals.findOne({ _id: '$PRINCIPAL_ID' }))" > subject-identity.json

$COMPOSE exec -T mongo mongosh aia_router --quiet --eval "
  db.inference_audit.find({ principalId: '$PRINCIPAL_ID' }).toArray()" > subject-usage.json

$COMPOSE exec -T mongo mongosh aia_agent_runtime --quiet --eval "
  db.runs.find({ principal_id: '$PRINCIPAL_ID' }).toArray()" > subject-runs.json

$COMPOSE exec -T mongo mongosh aia_mcp_gateway --quiet --eval "
  db.tool_invocations.find({ principalId: '$PRINCIPAL_ID' }).toArray()" > subject-tools.json

# Two different people can appear in one annotation: the ANNOTATOR, in
# principal_id, and whoever wrote the question that was annotated, in the text.
# A subject-access request has to search both.
$COMPOSE exec -T mongo mongosh aia_evaluation --quiet --eval "
  db.annotations.find({ principal_id: '$PRINCIPAL_ID' }).toArray()" > subject-annotations.json
```

The run transcripts live in `aia_agent_runtime.checkpoints`, keyed by `run_id`
rather than by person, so they are reached through the run ids in
`subject-runs.json`.

Deliver it in a machine-readable format (JSON qualifies).

## Erasure

Erase in order, and record every step:

```bash
$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  db.personal_access_tokens.deleteMany({ principalId: '$PRINCIPAL_ID' })"

$COMPOSE exec -T mongo mongosh aia_router --quiet --eval "
  db.inference_audit.updateMany(
    { principalId: '$PRINCIPAL_ID' },
    { \$set: { principalId: 'anonymised', redactedPrompt: null, redactedCompletion: null } })"

# The transcripts go FIRST, while the runs still say which ones they are.
# Deleting the runs before them orphans every checkpoint beyond reach.
$COMPOSE exec -T mongo mongosh aia_agent_runtime --quiet --eval "
  const ids = db.runs.find({ principal_id: '$PRINCIPAL_ID' }, { _id: 1 })
                     .toArray().map(r => r._id);
  print('checkpoints: ' + db.checkpoints.deleteMany({ run_id: { \$in: ids } }).deletedCount);
  print('runs: ' + db.runs.deleteMany({ principal_id: '$PRINCIPAL_ID' }).deletedCount)"

$COMPOSE exec -T mongo mongosh aia_mcp_gateway --quiet --eval "
  db.tool_invocations.updateMany(
    { principalId: '$PRINCIPAL_ID' },
    { \$set: { principalId: 'anonymised' } })"

# An annotation is a judgement a person made about an answer, and it may quote
# the answer verbatim. The judgement is deleted rather than anonymised: unlike
# an inference record it is not accounting, and a failure taxonomy does not need
# to know who reported each case. What survives is the count, which is the part
# anybody uses.
$COMPOSE exec -T mongo mongosh aia_evaluation --quiet --eval "
  print('annotations: ' +
    db.annotations.deleteMany({ principal_id: '$PRINCIPAL_ID' }).deletedCount)"

$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  db.principals.deleteOne({ _id: '$PRINCIPAL_ID' })"
```

**A label exported from an annotation is a copy in Git.** `evaluation labels`
appends to `evals/labels/*.jsonl`, and erasing the database does not reach a
file that has been committed and pushed. When the subject is the annotator,
`labelled_by` carries their principal id; when the subject wrote the question,
their words may be in the label itself. Grep the label files for the principal
id and for any identifier from the request, remove what matches in a commit of
its own, and re-run `make calibrate` -- a calibration measured against labels
that no longer exist is a number nobody can reproduce.

**Why the transcripts are deleted but the audit trails are anonymised**: a run
transcript is content, held under the project's own legal basis and useful to
nobody once the person is gone. A tool invocation and an inference record are
accounting: the usage and cost
record has its own legal basis (regulatory obligation and legitimate interest in
financial reconciliation). Removing the link to the person satisfies LGPD without
destroying the project's accounting. Agree it with the DPO before applying.

## Record the evidence

For each request: identifier, date, what was done, who executed it and the
outcome. Without that record, the platform cannot demonstrate compliance.

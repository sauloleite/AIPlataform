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
| `aia_router.inference_audit`           | principal_id, project, tokens, cost, zone | 90 days (TTL)                 |
| `aia_router.inference_audit` (content) | **redacted** prompt and answer            | only with project opt-in      |
| Redis Streams                          | events carrying principal_id              | the stream's length cap       |
| Traces                                 | `aia.principal_id`                        | per the backend's retention   |

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
```

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

$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  db.principals.deleteOne({ _id: '$PRINCIPAL_ID' })"
```

**Why anonymise the audit trail instead of deleting it**: the usage and cost
record has its own legal basis (regulatory obligation and legitimate interest in
financial reconciliation). Removing the link to the person satisfies LGPD without
destroying the project's accounting. Agree it with the DPO before applying.

## Record the evidence

For each request: identifier, date, what was done, who executed it and the
outcome. Without that record, the platform cannot demonstrate compliance.

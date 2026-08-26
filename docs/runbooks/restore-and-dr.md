# Restore and recovery test

**Trigger**: quarterly (a test), or data loss (for real).

A backup that has never been tested is not a backup. This runbook exists to be
executed on a quiet day.

## What needs a backup, and what does not

| Component    | Backup            | Why                                                                 |
| ------------ | ----------------- | ------------------------------------------------------------------- |
| MongoDB      | **Yes, critical** | Projects, budgets, audit, outbox, signing key                       |
| Redis        | Recommended       | Budget counters. Losing them means reconciling from the audit trail |
| MinIO        | **Yes**           | Original documents                                                  |
| Qdrant       | No                | Rebuildable from the documents in MinIO                             |
| Ollama       | No                | Models can be pulled again                                          |
| Grafana LGTM | Optional          | Historical telemetry                                                |

Leaving Qdrant out of the backup is a conscious decision: reindexing costs CPU
time, storing a vector index costs space and can end up inconsistent with the
source anyway.

## Backup

```bash
COMPOSE="docker compose -f deploy/compose/docker-compose.yml"
DATE=$(date +%Y%m%d)

$COMPOSE exec -T mongo mongodump --archive --gzip > "backup-mongo-${DATE}.gz"
$COMPOSE exec -T redis redis-cli SAVE
docker run --rm -v aia_minio-data:/data -v "$PWD:/backup" alpine \
  tar czf "/backup/backup-minio-${DATE}.tar.gz" -C /data .
```

Store it off the host. A backup on the same disk does not survive what usually
destroys the disk.

## Restore

```bash
$COMPOSE down
$COMPOSE up -d mongo redis minio
$COMPOSE exec -T mongo mongorestore --archive --gzip --drop < backup-mongo-YYYYMMDD.gz
docker run --rm -v aia_minio-data:/data -v "$PWD:/backup" alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/backup-minio-YYYYMMDD.tar.gz -C /data"
$COMPOSE up -d
```

## Validate the restore

Restoring without validating only postpones finding the problem:

```bash
make e2e
```

Check specifically:

- [ ] Login works (the signing key came back with it)
- [ ] Projects and budgets are there
- [ ] The audit trail has the records from before the backup
- [ ] A fresh inference works end to end

## Record it (quarterly test)

- Start and end time: **the real measured RTO**
- Timestamp of the backup used versus the moment of failure: **the real RPO**
- What failed or surprised you

If the measured RTO does not meet the target, the plan has to change — not the
target.

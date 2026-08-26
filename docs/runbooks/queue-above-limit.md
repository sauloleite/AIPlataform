# Queue above its limit

**Trigger**: the length of a stream or of a BullMQ queue growing steadily, or a
dead-letter backlog building up.

## Diagnosis

```bash
# Size of the event streams
docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli --scan --pattern 'aia:events:*' \
  | while read -r s; do
      echo "$s $(docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli XLEN "$s")"
    done
```

```bash
# Pending messages (consumed and unacknowledged) per group
docker compose -f deploy/compose/docker-compose.yml exec -T redis \
  redis-cli XPENDING aia:events:aia.inference.usage.recorded.v1 aia-data-platform
```

```bash
# Outbox: events that never made it out
docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
db.outbox.aggregate([{ $group: { _id: "$status", total: { $sum: 1 } } }])'
```

## Action

1. **An outbox with `pending` piling up** means the relay is not publishing.
   Check the producer log: it is usually Redis being down (see the corresponding
   runbook). The events are NOT lost; the relay publishes them once it is back.

2. **An outbox with `failed`** means the event exhausted its attempts. It stopped
   being retried on purpose, so it stays visible. Investigate `lastError`, fix it
   and put the event back to `pending`:

   ```javascript
   db.outbox.updateMany({ status: 'failed' }, { $set: { status: 'pending', attempts: 0 } });
   ```

3. **High pending counts at the consumer** mean it is slow or stuck. Scale
   consumer replicas. Under compose, `--scale`; on Kubernetes, adjust the HPA or
   KEDA.

4. **If it is document ingestion**, reduce the embedding batch size before
   scaling: a large batch against a rate-limiting provider produces cascading
   retries.

## Afterwards

- Tune the alert to fire on the TREND, not on the absolute value: a queue sitting
  steady at 10 thousand items is healthy; one at a thousand and growing is not.

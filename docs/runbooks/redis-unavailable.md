# Redis unavailable

**Trigger**: the Redis healthcheck failing, or responses carrying
`aia.budget_unverified = true`.

## Impact

Redis underpins two things: the atomic budget counter and the event bus (Redis
Streams).

**The platform does NOT stop.** `RedisBudgetLedger` detects the unavailability
and the router enters `budget_unverified` mode: it serves under a conservative
per-request ceiling and flags every response and every event for later
reconciliation. That was an explicit decision (reference doc 02 §8) — bringing
down all inference because of the counter would be worse than overspending a
little for a few minutes.

**The real risk is financial**: during the window, a project can exceed its
budget. The longer the window, the larger the possible overspend.

## Diagnosis

```bash
docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli ping
docker compose -f deploy/compose/docker-compose.yml logs redis --tail 50
docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli info memory | grep -E "used_memory_human|maxmemory_human"
```

## Action

1. **If memory is full** (the most common cause): the production compose uses
   `maxmemory-policy noeviction` on purpose — silently evicting a budget counter
   would be worse than failing. Raise `maxmemory` and restart.

2. **If the process died**: bring it back up. `appendonly yes` preserves the
   counters.

   ```bash
   docker compose -f deploy/compose/docker-compose.yml up -d redis
   ```

3. **Confirm the router left degraded mode**: the message
   "Redis is back. Budget is verified again." appears in the log.

4. **Reconcile the window's usage.** The real spend is in the MongoDB audit
   trail, which does not depend on Redis:

   ```bash
   docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
   db.inference_audit.aggregate([
     { $match: { occurredAt: { $gte: new Date("YYYY-MM-DDTHH:MM:SSZ") } } },
     { $group: { _id: "$projectId", micros: { $sum: { $toLong: "$costMicros" } } } },
     { $sort: { micros: -1 } }
   ])'
   ```

   Compare it with the Redis counter and adjust the difference.

## Afterwards

- If the window went past 15 minutes, consider Redis with a replica and failover.
- Check whether any project blew its budget during the window and take it up with
  the owner.

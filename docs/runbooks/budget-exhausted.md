# Budget exhausted, or close to it

**Trigger**: `aia_inference_cost_micros_total` rising fast for one project, or a
caller reporting `budget_exhausted` (HTTP 429).

## What already happened on its own

The platform does not stop a project by surprise. Read this before acting:

- Every call **reserves** an estimate before it runs and **commits** the real
  cost afterwards, in Redis. A reservation that is never committed expires, so a
  crash costs the project nothing.
- When the project's budget has `blockAtLimit`, a call that would cross the
  limit is refused with `budget_exhausted` — the request never reaches a
  provider, so a blocked project spends nothing further.
- When it does not, the call proceeds and the overspend is recorded. That is a
  policy choice made per project, not an accident.
- If **Redis was unreachable**, the answer went out carrying
  `budget_unverified`: the spend happened and was not counted. Those calls are
  capped at `BUDGET_UNVERIFIED_MAX_TOKENS` each, so the exposure is bounded,
  and the counter is behind reality until reconciliation runs.

## Decide what this is

```bash
TOKEN=...   # a platform_admin or project_owner token
PROJECT=... # the project id from the alert's aia_project_id label

# The limit, the period, and what the platform believes was spent.
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/v1/projects/$PROJECT/budget" | python3 -m json.tool
```

| What you see                                  | What it means                                  | What to do                                             |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Spend near the limit, traffic normal          | The project is simply using the platform       | Raise the budget, or let it block                      |
| Spend jumped without traffic jumping          | A more expensive alias or deployment took over | Check `aia.alias` and `gen_ai.request.model` on traces |
| Spend jumped with traffic                     | A loop, a retry storm, or a new integration    | Find the principal on the traces before raising it     |
| `budget_unverified` in responses or on traces | Redis was unreachable; the counter is behind   | See `redis-unavailable.md` first — the number is wrong |

## Raise the budget

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "http://localhost:8080/v1/projects/$PROJECT/budget" \
  -d '{"currency":"BRL","micros":"200000000","period":"monthly","block_at_limit":true}'
```

`micros`, not a decimal: money is an integer everywhere in this platform, and a
budget typed as a float is a budget that drifts.

**Prefer `block_at_limit: true`.** A project that stops is a conversation with
its owner; a project that silently overspends is a conversation with finance.

## Do not do this

- **Do not delete the Redis counters to "reset" a project.** The reservations
  belong to calls that are in flight, and the committed total is what
  reconciliation compares against. Change the limit instead.
- **Do not raise the budget to clear an alert without reading the traces.** The
  commonest cause of a sudden jump is a loop, and a bigger budget makes it a
  more expensive loop.

## Afterwards

- If the jump was a loop, the per-token rate limit is the durable fix (roadmap
  M12); note the project on the issue so it is exercised.
- If the counter was behind because Redis was down, reconciliation is what
  restores it (roadmap M8, `redis-unavailable.md`). Until that ships, the
  committed total under-reports and the drift never closes on its own.

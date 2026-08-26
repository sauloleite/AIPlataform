# Degraded model provider

**Trigger**: a circuit open for a deployment for more than 5 minutes, or an
`all_deployments_failed` rate above 1% over 5 min.

## What already happened on its own

Before acting, understand what the platform already did: `DeploymentExecutor`
tried the next compatible deployment in the priority list, and the circuit
breaker stopped hitting the bad provider. If the alias has local coverage
(Ollama), traffic may have moved there without anyone noticing. **Check whether
there is real impact before escalating.**

## Diagnosis

```bash
# Which deployment is failing and why
docker compose -f deploy/compose/docker-compose.yml logs inference-router --since 15m \
  | grep -E "circuit for|failed \(" | tail -30
```

```bash
# Provider distribution over the last 15 min (did traffic move?)
docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
db.inference_audit.aggregate([
  { $match: { occurredAt: { $gte: new Date(Date.now() - 15*60*1000) } } },
  { $group: { _id: { provider: "$provider", status: "$status" }, total: { $sum: 1 } } },
  { $sort: { total: -1 } }
])'
```

In Grafana: Explore > Tempo, query `{ span.gen_ai.system = "openai" && status = error }`.

## Action

1. **Confirm it is the provider, not the network.** Call the provider from inside
   the router container; if it answers, the problem is somewhere else.

   ```bash
   docker compose -f deploy/compose/docker-compose.yml exec -T inference-router \
     /nodejs/bin/node -e "fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY}}).then(r=>console.log(r.status))"
   ```

2. **If the provider is down**, check its status page. There is nothing to do
   beyond making sure the alias has an alternative.

3. **If the alias has no alternative**, add a contingency deployment to the
   catalogue (`alias-catalog.ts`) and redeploy. A local deployment (Ollama) as
   the last priority covers this case permanently.

4. **If it is a persistent 429**, the provider's `Retry-After` already sets how
   long the circuit stays open. If it is a quota, raise it at the provider or
   reduce the maximum concurrency of the heaviest projects.

5. **Notify the affected projects**, identified by the diagnosis query.

## Afterwards

- If the alias was left with no alternative, that is a finding: every alias in
  production should have at least two deployments (reference doc 04 §12).
- Record the real outage duration for the SLO calculation.

# Announced model deprecation

**Trigger**: an alert 60 days before the date in a deployment's `deprecatedAt`,
or a provider announcement.

Model lifecycle is handled as a release promotion, not as a configuration change
(reference doc 02 §11). A new model answers differently, and "differently" in
production is an incident.

## Action

1. **Confirm who uses it.** Without this you do not know the size of the problem.

   ```bash
   docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
   db.inference_audit.aggregate([
     { $match: { deploymentId: "openai-mini", occurredAt: { $gte: new Date(Date.now() - 30*24*3600*1000) } } },
     { $group: { _id: "$projectId", calls: { $sum: 1 } } },
     { $sort: { calls: -1 } }
   ])'
   ```

2. **Register the candidate** in the alias catalogue with a HIGHER priority than
   the current one (a larger number), disabled.

3. **Run the regression suite** against the candidate:

   ```bash
   make eval SUITE=evals/suites/model-regression
   ```

   Compare groundedness, relevance, cost per answer and latency. A drop beyond
   the threshold blocks the swap.

4. **Canary by project.** Enable the candidate for one volunteer project, leaving
   the current one as fallback. Watch it for a week.

5. **Swap the priorities** once the canary is clean: the candidate takes over,
   the old one becomes the fallback.

6. **Disable the old one** after two weeks with no regression, and only then
   remove it.

7. **Notify the projects** identified in step 1, with notice and with the numbers
   from the comparison.

## If the date arrives with no approved replacement

Better to degrade in a controlled way than to break: point the alias at the local
deployment (Ollama) and communicate the change in quality. A worse answer beats
`no_compatible_deployment`.

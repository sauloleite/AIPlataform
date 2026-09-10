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

2. **Register the candidate** with a HIGHER priority than the current one (a
   larger number), disabled.

   > **Today this is a code change and a deploy.** The catalogue is still
   > compiled into the router (`defaultAliasCatalog()` in
   > `apps/inference-router/.../registry/alias-catalog.ts`), so edit it there and
   > release. Moving the catalogue into `aia-registry`, which is what makes this
   > a configuration change, is roadmap M12.

3. **Run the regression suite** against the candidate.

   > `make eval SUITE=path` works now and takes a file or a directory. What is
   > still missing is `evals/suites/model-regression` itself: gate on
   > `evals/suites/platform-runbook.yaml` in the meantime, and note that it
   > needs a judge alias, so it measures nothing without one.
   > Until then, compare by hand against a suite you write for the occasion and
   > record the numbers in the change ticket. Do not skip the comparison because
   > the automation is missing — a model swap without one is the incident this
   > runbook exists to prevent.

   Compare groundedness, relevance, cost per answer and latency. A drop beyond
   the threshold blocks the swap.

4. **Canary by project.** Enable the candidate for one volunteer project, leaving
   the current one as fallback. Watch it for a week.

   > The Gateway API migration shipped (ADR-024), and its weights split traffic
   > between BACKEND SERVICES — not between two model deployments behind one
   > alias, which is what a model canary needs. Per project remains the
   > mechanism, and it is the more useful one anyway: a project is a population
   > whose quality you can compare, and a percentage of requests is not.

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

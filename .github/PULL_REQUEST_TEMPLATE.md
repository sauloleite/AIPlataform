## What changes

<!-- One sentence. The why goes in the next section. -->

## Why

<!-- The problem solved. If it changes an architecture decision, point at the ADR. -->

## Checklist

- [ ] Commits follow Conventional Commits
- [ ] `make check` passes locally (lint, types, architecture, tests)
- [ ] The OpenAPI/AsyncAPI contract is updated when the API changed
- [ ] Error paths are covered by tests
- [ ] No secret in code, logs or a committed variable
- [ ] Telemetry carries `aia.project_id` on the new spans
- [ ] An ADR is created or updated when the decision is structural
- [ ] A reviewer from another service is tagged

## Risk and rollback

<!-- What breaks if this goes wrong, and how to roll back. -->

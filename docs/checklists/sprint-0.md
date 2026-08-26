# Sprint 0 checklist

From reference doc 03 §11, adapted for the open source, cloud-agnostic version.
What is already done in this repository is ticked.

## Foundations

- [x] Name, internal domain and naming convention (`aia-<service>`, `@aia/<package>`, `aia_<package>`)
- [x] Monorepo with the structure from §2, `CODEOWNERS`, PR and ADR templates
- [x] Shared libraries in both languages, with tests
- [x] Service generators producing the §3 skeleton
- [x] Initial OpenAPI contracts (router, identity, governance, guardrails)
- [x] AsyncAPI event contract, with a CloudEvents envelope
- [x] CI pipeline with every stage from §8
- [x] ADR-001 through ADR-015 written and reviewable

## Replacing what used to be the cloud's

- [x] A complete local environment in containers (with no cloud account at all)
- [x] Our own identity issuer, with JWKS and a persisted key
- [x] Service credentials through `client_credentials` (in place of Managed Identity)
- [x] Our own guardrails with Brazilian PII redaction
- [x] Observability with the OTel Collector and Grafana LGTM
- [x] Packaging for self-hosting (production compose) and Kubernetes (Helm)

## Before going to production

- [ ] Secrets moved to Vault or Infisical (ADR-015, level 3)
- [ ] Token signing key generated and stored in the vault
- [ ] MongoDB backup automated and **restore tested**
- [ ] Dashboard with the SLOs from reference doc 02 §11
- [ ] Alerts: budget at 50/80/100%, circuit open, queue growing, outbox stalled
- [ ] A `platform-ci` project with its own budget for evaluations
- [ ] A conversation with compliance and the DPO: classification, regions, retention
- [ ] A game day exercising at least three runbooks

## Minimum team to carry on

Reference doc 03 suggests 8 to 12 people for the full roadmap. For phases 0 and 1
of this version, the real minimum is smaller:

| Role                 | Count     |
| -------------------- | --------- |
| TypeScript backend   | 2         |
| Python / AI backend  | 1         |
| Platform (SRE)       | 1         |
| Application security | part-time |
| Product owner        | 1         |

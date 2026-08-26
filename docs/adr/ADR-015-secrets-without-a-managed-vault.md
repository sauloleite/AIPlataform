# ADR-015: Secrets without a managed cloud vault

- **Status**: accepted (new)
- **Date**: 2026-08-25

## Context

Reference doc 02 uses Azure Key Vault with Managed Identity, and explicitly
forbids secrets in environment variables. The rule is right; the mechanism is not
available outside Azure.

## Decision

Three levels, depending on where the platform runs:

1. **Development**: a `.env` file, out of Git, generated from `.env.example`. No
   real secrets, and the signing key is generated and persisted on its own
   (ADR-004) — nobody has to generate or commit anything.
2. **Self-hosted (production compose)**: Docker secrets from files in
   `deploy/compose/secrets/`, mounted at `/run/secrets/`. An environment variable
   leaks through `docker inspect` and crash logs; a file with mode 600 does not.
3. **Kubernetes**: cluster Secrets, with the path open to External Secrets
   Operator pointing at Vault, Infisical or a cloud vault.

**Rules that hold at every level:**

- No secret in the repository. `gitleaks` scans the history on every PR.
- A missing provider key **disables that provider** rather than bringing the
  service down. The platform starts identically with zero, one or four keys.
- A service secret is compared by HMAC with a pepper, and password hashing uses
  Argon2id. A database leak hands over no usable credential.
- Rotating a SERVICE secret means changing the variable and restarting: the
  bootstrap rotates the stored hash. The bootstrap ADMIN password is different —
  it is written once and a restart never overwrites it, so that a restart cannot
  silently undo a password the administrator changed themselves. Rotating that
  one is a deliberate procedure, in the secret rotation runbook.

## Alternatives considered

| Alternative          | Why not as the DEFAULT                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HashiCorp Vault      | Excellent and still recommended in production. Requiring Vault to run locally would put off anyone who just wants to try it. |
| Infisical            | Same consideration; it is the simpler of the two to operate.                                                                 |
| SOPS with an age key | Good for GitOps. It fits as a complement, not as a replacement for a runtime vault.                                          |

## Consequences

**Easier**: no vault dependency to get started. `make dev` works with no real
secret at all.

**Harder**: on self-hosted setups, rotation is manual. The secret rotation
runbook covers the procedure.

**Explicit limit**: this ADR delivers neither secret access auditing nor
automatic rotation. Anyone who needs that — and a regulated institution does —
uses Vault or Infisical at level 3.

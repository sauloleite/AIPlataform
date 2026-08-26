# Secret rotation

**Trigger**: a detected leak (gitleaks, a provider notice) or scheduled routine.

On a leak, order matters: **revoke at the provider first**, then reconfigure.
Reconfiguring first leaves the leaked credential valid for longer.

## Model provider key

1. Revoke the key in the provider's console. The platform starts returning 401
   from that provider and the circuit breaker opens; traffic moves to the alias's
   next deployment.
2. Generate the new key and update it:

   - **Compose**: edit `deploy/compose/secrets/openai_api_key.txt`.
   - **Kubernetes**: `kubectl create secret generic aia-providers --from-literal=openai-api-key=NEW --dry-run=client -o yaml | kubectl apply -f -`

3. Restart the router. A missing or invalid key does not bring the service down:
   that provider simply drops out of routing.

## Service credential (client_credentials)

1. Generate a new secret: `openssl rand -base64 48`.
2. Update it on BOTH sides: `IDENTITY_BOOTSTRAP_SERVICE_CLIENTS` in identity and
   `ROUTER_CLIENT_SECRET` in the router.
3. Restart identity first: the bootstrap rewrites the hash.
4. Restart the consumer. Already issued tokens stay valid until they expire.

## Bootstrap administrator password

`IDENTITY_BOOTSTRAP_ADMIN_PASSWORD` is read only when the administrator does not
yet exist. Changing the variable and restarting does NOTHING — the bootstrap
returns early when it finds the account, so a restart cannot silently reset a
password someone changed on purpose.

To rotate it, remove the principal so the bootstrap recreates it:

```bash
COMPOSE="docker compose -f deploy/compose/docker-compose.yml"

# 1. Set the new value (8 characters minimum, or identity refuses to start).
#    In .env for compose, or in the Secret for Kubernetes.

# 2. Remove the account.
$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval \
  'db.principals.deleteOne({ email: "admin@aia.local" })'

# 3. Restart identity. The bootstrap recreates it with the new password.
$COMPOSE up -d --force-recreate identity
```

Check first what the account carries: `memberships` and PATs do NOT survive,
because the recreated principal gets a new id.

```bash
$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval '
  const p = db.principals.findOne({ email: "admin@aia.local" });
  print(JSON.stringify({ memberships: p.memberships || [],
                         pats: db.personal_access_tokens.countDocuments({ principalId: p._id }) }))'
```

If either is non-empty, grant the memberships again and reissue the PATs after
the restart. Audit records keep the OLD id, and that is correct: the trail has to
say who actually made each call, not who holds the address today.

## Token signing key

The most delicate one: swapping it carelessly invalidates ALL tokens in use.

1. Generate the new key:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out new.pem
   ```

2. **Keep the old key in the JWKS** until the tokens signed with it expire (the
   default TTL is 1 h). `MongoSigningKeyStore.rotate()` does exactly that: it
   retires the active key but keeps it published.
3. Configure the new one as active and restart identity.
4. The services reload the JWKS on their own when they meet an unknown signature.
5. After twice the TTL, remove the old one.

## PAT hash pepper

**It cannot be rotated without invalidating every PAT**: the hash is
deterministic and depends on it. Rotating it means notifying the owners and
reissuing. Treat it as a planned event, never as routine maintenance.

## After any rotation

- Confirm `gitleaks` does not find the secret in the history. If it does,
  rewriting the history is mandatory: a secret in a public commit is public.
- Record the rotation as audit evidence.

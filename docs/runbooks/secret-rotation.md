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

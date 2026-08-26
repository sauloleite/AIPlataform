# Rotacao de segredo

**Gatilho**: vazamento detectado (gitleaks, aviso do provedor) ou rotina
programada.

Em vazamento, a ordem importa: **revogue no provedor primeiro**, depois
reconfigure. Reconfigurar antes deixa a credencial vazada valida por mais tempo.

## Chave de provedor de modelo

1. Revogue a chave no painel do provedor. A plataforma passa a devolver 401
   daquele provedor e o circuit breaker abre; o trafego migra para o proximo
   deployment do alias.
2. Gere a nova chave e atualize:

   - **Compose**: edite `deploy/compose/secrets/openai_api_key.txt`.
   - **Kubernetes**: `kubectl create secret generic aia-providers --from-literal=openai-api-key=NOVA --dry-run=client -o yaml | kubectl apply -f -`

3. Reinicie o router. Chave ausente ou invalida nao derruba o servico: aquele
   provedor apenas sai do roteamento.

## Credencial de servico (client_credentials)

1. Gere um segredo novo: `openssl rand -base64 48`.
2. Atualize nos DOIS lados: `IDENTITY_BOOTSTRAP_SERVICE_CLIENTS` no identity e
   `ROUTER_CLIENT_SECRET` no router.
3. Reinicie o identity primeiro: o bootstrap reescreve o hash.
4. Reinicie o consumidor. Tokens ja emitidos continuam validos ate expirar.

## Chave de assinatura de token

A mais delicada: trocar sem cuidado invalida TODOS os tokens em uso.

1. Gere a nova chave:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out nova.pem
   ```

2. **Mantenha a chave antiga no JWKS** ate os tokens emitidos com ela expirarem
   (o TTL padrao e 1 h). O `MongoSigningKeyStore.rotate()` faz isso: aposenta a
   ativa mas a mantem publicada.
3. Configure a nova como ativa e reinicie o identity.
4. Os servicos recarregam o JWKS sozinhos ao encontrar uma assinatura desconhecida.
5. Depois de duas vezes o TTL, remova a antiga.

## Pepper do hash de PAT

**Nao pode ser rotacionado sem invalidar todos os PATs**: o hash e deterministico
e depende dele. Rotacionar exige avisar os donos e reemitir. Trate como evento
planejado, nunca como manutencao de rotina.

## Depois de qualquer rotacao

- Confirme que o `gitleaks` nao encontra o segredo no historico. Se encontrar,
  reescrever o historico e obrigatorio: um segredo em commit publico e publico.
- Registre a rotacao para a evidencia de auditoria.

# Pedido de titular (LGPD)

**Gatilho**: solicitacao encaminhada pelo DPO — acesso, correcao, portabilidade
ou eliminacao.

Prazo legal: 15 dias para acesso e portabilidade (LGPD, art. 19).

## O que a plataforma guarda sobre uma pessoa

Saber isto antes economiza tempo e evita resposta incompleta:

| Onde                                    | O que                                      | Retencao                     |
| --------------------------------------- | ------------------------------------------ | ---------------------------- |
| `aia_identity.principals`               | id, email, nome, papeis                    | enquanto a conta existir     |
| `aia_identity.personal_access_tokens`   | hash do token, nome, uso                   | 30 dias apos expirar         |
| `aia_router.inference_audit`            | principal_id, projeto, tokens, custo, zona | 90 dias (TTL)                |
| `aia_router.inference_audit` (conteudo) | prompt e resposta **redigidos**            | so com opt-in do projeto     |
| Redis Streams                           | eventos com principal_id                   | limite de tamanho do stream  |
| Traces                                  | `aia.principal_id`                         | conforme retencao do backend |

Conteudo de conversa so existe se o projeto habilitou `content_capture`, e mesmo
assim ja passou pela redacao de PII.

## Acesso e portabilidade

```bash
PRINCIPAL_ID="<id>"
COMPOSE="docker compose -f deploy/compose/docker-compose.yml"

$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  printjson(db.principals.findOne({ _id: '$PRINCIPAL_ID' }))" > titular-identidade.json

$COMPOSE exec -T mongo mongosh aia_router --quiet --eval "
  db.inference_audit.find({ principalId: '$PRINCIPAL_ID' }).toArray()" > titular-uso.json
```

Entregue em formato legivel por maquina (JSON atende).

## Eliminacao

Elimine na ordem, e registre cada passo:

```bash
$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  db.personal_access_tokens.deleteMany({ principalId: '$PRINCIPAL_ID' })"

$COMPOSE exec -T mongo mongosh aia_router --quiet --eval "
  db.inference_audit.updateMany(
    { principalId: '$PRINCIPAL_ID' },
    { \$set: { principalId: 'anonimizado', redactedPrompt: null, redactedCompletion: null } })"

$COMPOSE exec -T mongo mongosh aia_identity --quiet --eval "
  db.principals.deleteOne({ _id: '$PRINCIPAL_ID' })"
```

**Por que anonimizar a auditoria em vez de apagar**: o registro de consumo e
custo tem base legal propria (obrigacao regulatoria e legitimo interesse na
apuracao financeira). Remover o vinculo com a pessoa atende a LGPD sem destruir a
contabilidade do projeto. Alinhe com o DPO antes de aplicar.

## Registrar a evidencia

Para cada pedido: identificador, data, o que foi feito, quem executou e o
resultado. Sem esse registro, a plataforma nao consegue demonstrar conformidade.

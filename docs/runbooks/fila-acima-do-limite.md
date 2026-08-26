# Fila acima do limite

**Gatilho**: comprimento de um stream ou de uma fila BullMQ crescendo de forma
sustentada, ou dead-letter acumulando.

## Diagnostico

```bash
# Tamanho dos streams de evento
docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli --scan --pattern 'aia:events:*' \
  | while read -r s; do
      echo "$s $(docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli XLEN "$s")"
    done
```

```bash
# Mensagens pendentes (consumidas e nao confirmadas) por grupo
docker compose -f deploy/compose/docker-compose.yml exec -T redis \
  redis-cli XPENDING aia:events:aia.inference.usage.recorded.v1 aia-data-platform
```

```bash
# Outbox: eventos que nao chegaram a ser publicados
docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
db.outbox.aggregate([{ $group: { _id: "$status", total: { $sum: 1 } } }])'
```

## Acao

1. **Outbox com `pending` acumulando** significa que o relay nao esta publicando.
   Verifique o log do produtor: geralmente e o Redis fora (veja o runbook
   correspondente). Os eventos NAO se perdem; o relay os publica quando voltar.

2. **Outbox com `failed`** significa que o evento excedeu as tentativas. Ele
   parou de ser tentado de proposito, para ficar visivel. Investigue o
   `lastError`, corrija e volte para `pending`:

   ```javascript
   db.outbox.updateMany({ status: 'failed' }, { $set: { status: 'pending', attempts: 0 } });
   ```

3. **Pendentes altos no consumidor** significa que ele esta lento ou travado.
   Escale replicas do consumidor. No compose, `--scale`; no Kubernetes, ajuste o
   HPA ou o KEDA.

4. **Se for ingestao de documentos**, reduza o tamanho do lote de embeddings antes
   de escalar: lote grande com provedor limitando gera retry em cascata.

## Depois

- Ajuste o alerta para disparar pela TENDENCIA, e nao pelo valor absoluto: uma
  fila com 10 mil itens estavel e saudavel; uma com mil crescendo, nao.

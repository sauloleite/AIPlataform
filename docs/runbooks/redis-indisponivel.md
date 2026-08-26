# Redis indisponivel

**Gatilho**: healthcheck do Redis falhando, ou respostas com
`aia.budget_unverified = true`.

## Impacto

O Redis sustenta duas coisas: o contador atomico de orcamento e o barramento de
eventos (Redis Streams).

**A plataforma NAO para.** O `RedisBudgetLedger` detecta a indisponibilidade e o
router entra em modo `budget_unverified`: atende sob um teto conservador por
requisicao e marca cada resposta e cada evento para reconciliacao posterior. Foi
uma decisao explicita (doc 02, secao 8) — derrubar toda a inferencia por causa do
contador seria pior do que gastar um pouco a mais por alguns minutos.

**O risco real e financeiro**: durante a janela, um projeto pode ultrapassar o
orcamento. Quanto mais longa a janela, maior o estouro possivel.

## Diagnostico

```bash
docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli ping
docker compose -f deploy/compose/docker-compose.yml logs redis --tail 50
docker compose -f deploy/compose/docker-compose.yml exec -T redis redis-cli info memory | grep -E "used_memory_human|maxmemory_human"
```

## Acao

1. **Se for memoria cheia** (causa mais comum): o compose de producao usa
   `maxmemory-policy noeviction` de proposito — despejar um contador de orcamento
   silenciosamente seria pior do que falhar. Aumente `maxmemory` e reinicie.

2. **Se o processo morreu**: suba de novo. O `appendonly yes` preserva os
   contadores.

   ```bash
   docker compose -f deploy/compose/docker-compose.yml up -d redis
   ```

3. **Confirme que o router saiu do modo degradado**: a mensagem
   "Redis de volta. Orcamento verificado novamente." aparece no log.

4. **Reconcilie o consumo da janela.** O gasto real esta na auditoria do MongoDB,
   que nao depende do Redis:

   ```bash
   docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
   db.inference_audit.aggregate([
     { $match: { occurredAt: { $gte: new Date("AAAA-MM-DDTHH:MM:SSZ") } } },
     { $group: { _id: "$projectId", micros: { $sum: { $toLong: "$costMicros" } } } },
     { $sort: { micros: -1 } }
   ])'
   ```

   Compare com o contador do Redis e ajuste o que faltou.

## Depois

- Se a janela passou de 15 minutos, avalie Redis com replica e failover.
- Verifique se algum projeto estourou o orcamento durante a janela e trate com o
  dono.

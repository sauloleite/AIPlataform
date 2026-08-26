# Provedor de modelo degradado

**Gatilho**: circuito aberto para um deployment por mais de 5 minutos, ou taxa de
`all_deployments_failed` acima de 1% em 5 min.

## O que ja aconteceu sozinho

Antes de agir, entenda o que a plataforma ja fez: o `DeploymentExecutor` tentou o
proximo deployment compativel da lista de prioridade, e o circuit breaker parou de
bater no provedor ruim. Se o alias tem cobertura local (Ollama), o trafego pode
ter migrado para la sem ninguem perceber. **Verifique se ha impacto real antes de
escalar.**

## Diagnostico

```bash
# Qual deployment esta falhando e por que
docker compose -f deploy/compose/docker-compose.yml logs inference-router --since 15m \
  | grep -E "circuito de|falhou \(" | tail -30
```

```bash
# Distribuicao de provedores nos ultimos 15 min (o trafego migrou?)
docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
db.inference_audit.aggregate([
  { $match: { occurredAt: { $gte: new Date(Date.now() - 15*60*1000) } } },
  { $group: { _id: { provider: "$provider", status: "$status" }, total: { $sum: 1 } } },
  { $sort: { total: -1 } }
])'
```

No Grafana: Explore > Tempo, consulta `{ span.gen_ai.system = "openai" && status = error }`.

## Acao

1. **Confirme que e o provedor, e nao a rede.** Chame o provedor de dentro do
   container do router; se responder, o problema esta em outro lugar.

   ```bash
   docker compose -f deploy/compose/docker-compose.yml exec -T inference-router \
     /nodejs/bin/node -e "fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY}}).then(r=>console.log(r.status))"
   ```

2. **Se o provedor esta fora**, verifique a pagina de status dele. Nao ha o que
   fazer alem de garantir que o alias tem alternativa.

3. **Se o alias nao tem alternativa**, adicione um deployment de contingencia no
   catalogo (`alias-catalog.ts`) e reimplante. Um deployment local (Ollama) como
   ultima prioridade cobre esse caso permanentemente.

4. **Se for 429 persistente**, o `Retry-After` do provedor ja define quanto tempo
   o circuito fica aberto. Se for cota, aumente no provedor ou reduza a
   concorrencia maxima dos projetos mais pesados.

5. **Comunique os projetos afetados**, identificados pela consulta de diagnostico.

## Depois

- Se o alias ficou sem alternativa, isso e um achado: todo alias em producao
  deveria ter pelo menos dois deployments (doc 04, secao 12).
- Registre a duracao real da indisponibilidade para o calculo de SLO.

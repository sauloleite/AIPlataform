# Suspeita de injecao de prompt ou exfiltracao

**Gatilho**: aumento de `guardrail_blocked` ou `prompt_injection_suspected`, ou
relato de comportamento anomalo de um agente.

Trate como incidente de seguranca ate provar o contrario. Preserve evidencia
ANTES de mudar qualquer coisa.

## 1. Preservar evidencia

```bash
# Bloqueios recentes, por projeto e principal
docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
db.inference_audit.find(
  { errorCode: { $in: ["guardrail_blocked", "prompt_injection_suspected"] },
    occurredAt: { $gte: new Date(Date.now() - 24*3600*1000) } },
  { projectId: 1, principalId: 1, alias: 1, errorCode: 1, occurredAt: 1 }
).sort({ occurredAt: -1 }).limit(50)'
```

Guarde o `trace_id` das ocorrencias: o trace completo mostra o que o modelo
recebeu, qual deployment atendeu e quais tools foram chamadas.

## 2. Classificar

- **Falso positivo** (o mais comum): usuario legitimo perguntando SOBRE injecao de
  prompt, ou texto que casou com uma heuristica. Confirme pelo trecho registrado
  no sinal.
- **Teste** de alguem do time explorando os limites.
- **Ataque real**: padrao repetido, vindo de um principal so, ou conteudo
  recuperado de documento tentando redirecionar o modelo.

## 3. Conter (se for real)

1. **Congele a tool ou o projeto**, nao a plataforma inteira. Desabilite o alias
   ou reduza `max_concurrent_requests` do projeto pela API de governanca.
2. **Revogue os PATs** do principal envolvido.
3. **Se veio de documento ingerido** (injecao indireta), remova o documento do
   store e verifique a fonte: LLM04, envenenamento de dados.

## 4. Investigar

Perguntas que a evidencia precisa responder:

- Alguma tool foi executada? Com qual identidade?
- O conteudo saiu da plataforma? Para qual zona de dados?
- Houve tentativa de exfiltracao por URL?

```bash
docker compose -f deploy/compose/docker-compose.yml exec -T redis \
  redis-cli XRANGE aia:events:aia.tools.tool.invoked.v1 - + COUNT 100
```

## 5. Depois

- Se foi falso positivo, ajuste a heuristica em
  `apps/guardrails/src/guardrails/domain/injection.py` **e adicione um caso ao
  teste de falso positivo**. Sem o teste, a regressao volta.
- Se foi ataque real, adicione o payload a `evals/redteam/` para que o CI passe a
  detectar.
- Reveja se a tool envolvida precisava mesmo do escopo que tinha (LLM06).

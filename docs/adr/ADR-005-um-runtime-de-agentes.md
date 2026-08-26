# ADR-005: Um unico runtime de agentes

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

O achado 3.5 do documento 01: a plataforma anterior executava agentes em tres
frameworks diferentes no mesmo servico. Tres modelos mentais de estado, memoria,
streaming e chamada de tool.

Em contexto regulado o custo e maior do que parece: cada runtime precisa da mesma
revisao de seguranca contra agencia excessiva (OWASP LLM06), da mesma
instrumentacao e da mesma trilha de auditoria. Tres vezes.

## Decisao

**LangGraph** como unico runtime, pela execucao duravel com checkpointer e pelo
suporte nativo a interrupcao para aprovacao humana — os dois requisitos que a
plataforma tem e que nao sao triviais de construir.

Nesta fase o `aia-agent-runtime` e um esqueleto com a estrutura de camadas e os
ports corretos; o grafo entra na Fase 3 do roadmap.

## Alternativas consideradas

| Alternativa                                 | Por que nao                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Escrever o proprio runtime                  | Execucao duravel com retomada exata e um problema resolvido; reescrever seria trabalho sem diferencial. |
| Manter varios runtimes                      | Rejeitado por KISS e pelo custo triplicado de revisao de seguranca.                                     |
| Framework de agentes acoplado a um provedor | Contraria a independencia de cloud (ADR-012).                                                           |

## Consequencias

**Mais facil**: um modelo de estado, uma instrumentacao, uma revisao de seguranca.

**Mais dificil**: dependencia de um framework externo no caminho de execucao de
agente. O port `ModelClient` e o `container.py` isolam o LangGraph do dominio, o
que mantem a troca possivel.

## Revisao

Reavaliar em 12 meses, ou antes se o LangGraph deixar de suportar execucao
duravel do jeito que a plataforma precisa.

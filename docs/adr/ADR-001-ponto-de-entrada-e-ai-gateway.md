# ADR-001: Traefik como ponto de entrada; capacidades de AI Gateway dentro do router

- **Status**: aceito (revisa o ADR-001 do documento 02)
- **Data**: 2026-08-25

## Contexto

O documento 02 decidiu usar o Azure API Management em dois papeis: entrada unica
de APIs e AI Gateway para o Foundry, com limite de tokens, inspecao de conteudo,
balanceamento com circuit breaker e cache semantico configurados como politica.

O raciocinio era solido: essas capacidades sao commodity em gateways gerenciados,
e reimplementa-las e manter infraestrutura que nao diferencia ninguem.

Esta plataforma nao tem uma nuvem. O APIM nao existe aqui, e o gateway de API
open source mais proximo (Kong, Apigee) ou nao tem as politicas de LLM, ou traz
uma superficie operacional maior que o problema que resolve.

## Decisao

Dividir o papel em dois:

1. **Traefik** como ponto de entrada: TLS, roteamento, rate limit por rota e
   descoberta automatica de servico. E o que um proxy reverso faz bem, e o
   Traefik faz sem nenhuma configuracao alem de labels.

2. **As capacidades de AI Gateway ficam dentro do `aia-inference-router`**, em
   codigo: `DeploymentPool` faz balanceamento por prioridade com failover e
   circuit breaker por deployment, o teto de `max_tokens` sai do
   `ModelSelectionPolicy`, o cache fica no `RedisSemanticCache` e a inspecao de
   conteudo vai para o `aia-guardrails`.

## Alternativas consideradas

| Alternativa                          | Por que nao                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kong com AI Gateway                  | Traz um plano de controle proprio e um banco a mais para operar. O ganho seria configurar em YAML o que ja temos em codigo testado.                                                                                         |
| LiteLLM como proxy                   | Cobre bem o roteamento entre provedores, mas nao tem orcamento em moeda, nem politica por classificacao de dados, nem a auditoria que precisamos. Sobraria uma camada a mais no caminho critico fazendo metade do trabalho. |
| Apenas o router, sem proxy na frente | TLS, redirecionamento e rate limit de borda teriam que ser feitos em cada servico.                                                                                                                                          |

## Consequencias

**Mais facil**: o comportamento do AI Gateway virou codigo TypeScript com teste
unitario. Politica de balanceamento em XML de gateway e notoriamente dificil de
testar; aqui um failover entre deployments e um teste de 15 linhas.

**Mais dificil**: passamos a manter esse comportamento. Circuit breaker, retry
com jitter e cache sao codigo nosso, com bugs nossos. A mitigacao e que essa
logica vive em `@aia/resilience`, compartilhada e coberta por testes.

**Consequencia aceita**: o Traefik nao valida JWT. Cada servico valida
localmente pelo JWKS, o que ja era a decisao do ADR-004 e continua valendo.

## Revisao

Reavaliar se a plataforma passar a ser implantada predominantemente em uma nuvem
unica com gateway gerenciado, ou se o codigo de balanceamento e cache comecar a
gerar incidentes recorrentes.

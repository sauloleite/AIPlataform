# ADR-002: Inference router proprio e enxuto

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

Parte da governanca de IA nao cabe em politica de gateway: orcamento em MOEDA
(nao em tokens por minuto), decisao de roteamento condicionada a classificacao de
dados do projeto, auditoria com semantica de negocio e um catalogo de aliases com
ciclo de vida.

## Decisao

`aia-inference-router` em NestJS com Clean Architecture:

- **API canonica compativel com OpenAI** (`/v1/chat/completions`,
  `/v1/embeddings`, `/v1/models`). O consumidor escolhe um ALIAS, nunca um
  provedor.
- **Aliasing** com lista ordenada de deployments por prioridade.
- **Reserva e commit de orcamento** com scripts Lua atomicos no Redis.
- **Politicas por classificacao de dados** (ADR-010) como regra pura de dominio.
- **Auditoria** com identidade, projeto e zona de dados de cada chamada.

O que NAO entra: nada que possa ser resolvido por configuracao, e nenhuma
abstracao para provedor que ainda nao existe.

## Alternativas consideradas

| Alternativa                                   | Por que nao                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Deixar a aplicacao chamar o provedor direto   | Sem ponto unico, nao existe orcamento, nem auditoria, nem evidencia de residencia de dados. E o problema que a plataforma existe para resolver. |
| Usar o SDK de cada provedor em cada aplicacao | Cada troca de modelo viraria uma alteracao em N aplicacoes.                                                                                     |

## Consequencias

**Mais facil**: trocar de provedor e editar o catalogo de aliases. Nenhuma
aplicacao consumidora muda.

**Mais dificil**: o router e o caminho critico de toda inferencia da plataforma.
Ele precisa de SLO, de degradacao graciosa (`policy_stale`, `budget_unverified`)
e de teste de carga antes de cada release.

**Custo real**: um salto de rede a mais entre a aplicacao e o modelo.

## Revisao

Reavaliar se o overhead do salto passar a ser mensuravel no tempo ate o primeiro
token (SLO de 2 s, p95).

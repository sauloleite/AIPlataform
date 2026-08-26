# Registros de decisao de arquitetura (ADR)

Toda decisao estrutural vive aqui. Sem ADR, uma escolha vira folclore: ninguem
lembra por que foi feita, e ninguem se sente autorizado a mudar.

Os ADRs 001 a 011 vem do documento `docs/reference/02-arquitetura-alvo.md`, que
assume Azure como cloud primaria. Esta plataforma e **agnostica de cloud e open
source**, entao vários foram reescritos: cada um diz explicitamente o que muda em
relacao ao original e por que. Os ADRs 012 a 015 sao novos e existem justamente
por causa dessa mudanca de contexto.

| ADR                                                     | Decisao                                                          | Status                         |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------ |
| [001](ADR-001-ponto-de-entrada-e-ai-gateway.md)         | Traefik como entrada; capacidades de AI Gateway dentro do router | aceito (revisa o original)     |
| [002](ADR-002-inference-router-proprio.md)              | Inference router proprio e enxuto                                | aceito                         |
| [003](ADR-003-separar-identity-de-governance.md)        | Separar identidade de governanca                                 | aceito                         |
| [004](ADR-004-validacao-local-de-jwt.md)                | Validacao local de JWT com JWKS                                  | aceito                         |
| [005](ADR-005-um-runtime-de-agentes.md)                 | Um unico runtime de agentes (LangGraph)                          | aceito                         |
| [006](ADR-006-qdrant-como-indice-vetorial.md)           | Qdrant como indice vetorial padrao                               | aceito (substitui AI Search)   |
| [007](ADR-007-mongodb-como-banco-de-documentos.md)      | MongoDB como banco de documentos                                 | aceito (substitui Cosmos DB)   |
| [008](ADR-008-redis-streams-e-bullmq.md)                | Redis Streams e BullMQ para eventos e jobs                       | aceito (substitui Service Bus) |
| [009](ADR-009-opentelemetry-com-convencoes-genai.md)    | OpenTelemetry com convencoes `gen_ai.*`                          | aceito                         |
| [010](ADR-010-roteamento-por-classificacao-de-dados.md) | Roteamento de modelo condicionado a classificacao de dados       | aceito                         |
| [011](ADR-011-monorepo.md)                              | Monorepo para o nucleo                                           | aceito                         |
| [012](ADR-012-independencia-de-cloud.md)                | Independencia de cloud por ports                                 | aceito (novo)                  |
| [013](ADR-013-analitico-em-mongodb.md)                  | Analitico em MongoDB time-series, ClickHouse atras do port       | aceito (novo)                  |
| [014](ADR-014-guardrails-proprios.md)                   | Guardrails proprios com Presidio                                 | aceito (novo)                  |
| [015](ADR-015-segredos-sem-cofre-gerenciado.md)         | Segredos sem cofre gerenciado de nuvem                           | aceito (novo)                  |

Formato: contexto, decisao, alternativas, consequencias e gatilho de revisao.
Template em [TEMPLATE.md](TEMPLATE.md).

# ADR-012: Independencia de cloud por ports

- **Status**: aceito (novo; nao existe no documento 02)
- **Data**: 2026-08-25

## Contexto

Os documentos de referencia desenham a plataforma sobre Azure: APIM, Foundry,
Cosmos DB, AI Search, Service Bus, Key Vault, Entra ID, Application Insights.
A decisao e defensavel para uma instituicao que ja padronizou Azure.

O objetivo aqui e outro: **qualquer pessoa deve conseguir subir a propria AI
Platform**, em um notebook, numa VPS, num servidor da empresa ou em qualquer
nuvem. Isso muda o criterio de escolha de toda peca de infraestrutura.

## Decisao

**Cada peca gerenciada vira um port com implementacao padrao open source e
auto-hospedavel.** Trocar de nuvem — ou nao usar nenhuma — passa a ser trocar um
adapter, nunca reescrever um caso de uso.

| Papel              | Padrao OSS                            | Port                         |
| ------------------ | ------------------------------------- | ---------------------------- |
| Entrada            | Traefik                               | —                            |
| AI Gateway         | dentro do `aia-inference-router`      | `ModelProvider`              |
| Modelos            | OpenAI, Gemini, Anthropic, Ollama     | `ModelProvider`              |
| Identidade         | `aia-identity` (emissor OIDC proprio) | —                            |
| Documentos         | MongoDB                               | `*Repository`                |
| Cache e contadores | Redis                                 | `BudgetLedger`               |
| Eventos e filas    | Redis Streams, BullMQ                 | `EventPublisher`, `JobQueue` |
| Objetos            | MinIO                                 | `ObjectStore`                |
| Vetorial           | Qdrant                                | `VectorIndex`                |
| Analitico          | MongoDB time-series                   | `AnalyticsStore`             |
| Guardrails         | Presidio + heuristicas                | `Guardrail`                  |
| Observabilidade    | OTel Collector + Grafana LGTM         | —                            |
| Implantacao        | docker-compose e Helm                 | —                            |

Regra pratica: **nada de SDK de nuvem em `application/` ou `domain/`**. O
`dependency-cruiser` e o `import-linter` reprovam no CI.

## Alternativas consideradas

| Alternativa                               | Por que nao                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Seguir o desenho Azure                    | Exclui quem nao tem Azure, que e a maioria de quem quer subir a propria plataforma.                                           |
| Camada de abstracao multi-cloud pronta    | Abstracoes genericas entregam o menor denominador comum e ainda assim vazam. Um port por necessidade concreta e mais honesto. |
| Codigo especifico por nuvem, com branches | Multiplica caminhos de codigo e testes.                                                                                       |

## Consequencias

**Mais facil**: `make dev` sobe a plataforma inteira sem nenhuma conta, chave ou
cartao de credito. Com o Ollama, ela responde de verdade, com custo zero.

**Mais dificil**: perdemos capacidades gerenciadas que teriam vindo prontas —
cache semantico do APIM, reranker do AI Search, PTU do Foundry. Cada uma vira
codigo nosso ou fica fora de escopo, com a decisao registrada.

**Consequencia positiva inesperada**: o Ollama como zona `local` deu ao ADR-010
uma resposta mais forte do que a versao original tinha. Manter o dado dentro do
pais e uma coisa; nao deixar o dado sair da maquina e outra.

## Revisao

Reavaliar se a plataforma passar a ser implantada exclusivamente em uma nuvem e o
custo de manter os adapters OSS superar o valor da portabilidade.

# ADR-006: Qdrant como indice vetorial padrao

- **Status**: aceito (substitui o AI Search do ADR-006 original)
- **Data**: 2026-08-25

## Contexto

O documento 02 escolheu o Azure AI Search pela busca hibrida, reranker semantico
e filtros de seguranca integrados. Sem Azure, e preciso um equivalente
auto-hospedavel.

O requisito que nao pode ser perdido e o **security trimming**: a busca precisa
filtrar por `project_id` e por ACL de documento DENTRO da consulta, e nao depois.
Filtrar no cliente vaza resultado e ainda quebra a paginacao.

## Decisao

**Qdrant** como implementacao padrao do port `VectorIndex`: open source,
Apache 2.0, roda em um container, e o filtro por payload e aplicado durante a
busca vetorial — que e exatamente o que o security trimming exige.

Busca hibrida: vetor no Qdrant combinado com indice de texto do MongoDB.

## Alternativas consideradas

| Alternativa                 | Por que nao                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| pgvector                    | Excelente quando ja existe um Postgres. Traz um banco a mais para uma plataforma que ja padronizou MongoDB. |
| MongoDB Atlas Vector Search | Evitaria um componente, mas nao e auto-hospedavel: prenderia a plataforma ao Atlas, contra o ADR-012.       |
| Chroma                      | Mais simples, mas com historico de mudancas de API e menos maduro em filtro por payload.                    |
| Elasticsearch/OpenSearch    | Faz busca hibrida muito bem, ao custo de uma operacao bem maior.                                            |

## Consequencias

**Mais facil**: busca vetorial com filtro de seguranca sem nenhum servico
gerenciado.

**Mais dificil**: o reranker semantico nao vem pronto. Quando for necessario,
entra como um passo explicito de reranking pelo router.

**Nao amarra**: o port `VectorIndex` mantem possivel trocar por AI Search,
pgvector ou Vertex AI Search sem tocar em caso de uso.

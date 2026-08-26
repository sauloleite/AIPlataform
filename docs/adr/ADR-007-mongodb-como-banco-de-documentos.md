# ADR-007: MongoDB como banco de documentos

- **Status**: aceito (substitui o Cosmos DB do ADR-007 original)
- **Data**: 2026-08-25

## Contexto

O documento 02 escolheu Cosmos DB for MongoDB (vCore) para manter a API do
MongoDB com replicacao gerenciada. Sem Azure, usamos o MongoDB direto.

Duas capacidades sao requisito, e nao preferencia:

- **Transacao multi-documento**, porque o padrao outbox grava o estado e o evento
  na mesma transacao. Sem isso, um crash entre as duas escritas deixa o sistema
  inconsistente.
- **TTL index**, para que retencao de auditoria e de conversa (LGPD) seja
  aplicada pelo banco, e nao por um job que alguem pode esquecer de monitorar.

## Decisao

**MongoDB 8** em replica set (mesmo que de um no unico em desenvolvimento, porque
transacao exige replica set). Um database por servico.

## Alternativas consideradas

| Alternativa            | Por que nao                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL             | Tecnicamente superior em varios aspectos, e permitiria unificar com pgvector. Descartado porque os documentos de referencia, o modelo de dados e a experiencia do time assumem MongoDB; a troca seria uma reescrita sem ganho proporcional. |
| Cosmos DB / DocumentDB | Prenderia a plataforma a uma nuvem (ADR-012).                                                                                                                                                                                               |
| SQLite                 | Simples demais para multi-replica.                                                                                                                                                                                                          |

## Consequencias

**Mais facil**: um `docker compose up` traz o banco inteiro. O mesmo codigo roda
contra MongoDB auto-hospedado, Atlas, Cosmos DB ou DocumentDB.

**Mais dificil**: replica set e obrigatorio ate em desenvolvimento, o que
surpreende quem espera um `mongod` solto. O compose ja inicializa sozinho.

**Consequencia operacional**: backup e responsabilidade de quem hospeda. O
runbook de restauracao cobre o procedimento.

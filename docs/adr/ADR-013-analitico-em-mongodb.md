# ADR-013: Analitico em MongoDB time-series, ClickHouse atras do port

- **Status**: aceito (novo)
- **Data**: 2026-08-25

## Contexto

O documento 02 usa Azure Data Explorer com arquitetura Medallion para consumo,
custo e auditoria. ADX e excelente e caro, e nao tem equivalente direto OSS que
seja igualmente simples de operar.

O volume real precisa ser dito com honestidade: uma plataforma com 500 usuarios
ativos gera algo como dezenas de milhares de eventos de inferencia por dia. Isso
nao e volume de banco colunar.

## Decisao

**Comecar com collections time-series do MongoDB** para as camadas Bronze, Silver
e Gold, atras do port `AnalyticsStore`. O MongoDB ja e obrigatorio, ja tem
agregacao suficiente para custo por projeto, por alias e por usuario, e TTL index
para retencao.

**ClickHouse entra atras do mesmo port** quando o volume justificar — e o gatilho
e mensuravel, nao opiniao: quando a agregacao diaria de custo passar de 30 s, ou
quando a retencao quente ultrapassar 100 milhoes de eventos.

## Alternativas consideradas

| Alternativa               | Por que nao AGORA                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ClickHouse desde o inicio | Mais um servico com estado para operar, para um volume que o MongoDB atende. Continua sendo a proxima escolha. |
| DuckDB sobre Parquet      | Otimo para analise local, ruim para escrita continua e concorrente.                                            |
| Manter tudo em log        | Nao responde "quanto o projeto X gastou este mes" sem varrer tudo.                                             |

## Consequencias

**Mais facil**: zero componentes novos. FinOps sai de uma agregacao sobre dados
que ja estao la.

**Mais dificil**: consulta analitica compete com a carga transacional no mesmo
banco. Mitigado por collections separadas e por leitura em replica secundaria.

**Divida assumida e registrada**: este ADR existe para que a troca por ClickHouse
seja uma decisao planejada com gatilho definido, e nao uma descoberta em incidente.

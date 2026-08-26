# ADR-008: Redis Streams e BullMQ para eventos e jobs

- **Status**: aceito (substitui o Service Bus do ADR-008 original)
- **Data**: 2026-08-25

## Contexto

O documento 02 escolheu Azure Service Bus para eventos de negocio e filas de
trabalho, com Event Hubs reservado para telemetria de alto volume.

O que a plataforma realmente precisa de um barramento: entrega ao menos uma vez,
grupos de consumidores, ack explicito, visibilidade das mensagens pendentes para
dead-letter e retencao limitada.

O Redis ja e uma dependencia OBRIGATORIA da plataforma, porque e onde vive o
contador atomico de orcamento. Adicionar um broker separado significaria mais um
componente para operar, monitorar e fazer backup.

## Decisao

- **Redis Streams** para eventos de negocio: um stream por tipo de evento, grupo
  de consumidores por servico, `XACK` explicito e `XPENDING` para dead-letter.
- **BullMQ** para filas de trabalho (ingestao, extracao, avaliacao), que traz
  retry com backoff, prioridade e dead-letter prontos.
- **Padrao outbox** no produtor, sempre: o evento e gravado no MongoDB junto da
  mudanca de estado, e um relay publica depois. Isso vale independente do broker.

## Alternativas consideradas

| Alternativa           | Por que nao                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Kafka / Redpanda      | Retencao longa e reprocessamento historico sao otimos, ao custo de operar um cluster. Desproporcional para o volume esperado. |
| RabbitMQ              | Semantica de fila madura, mas seria mais um servico com estado para operar quando o Redis ja atende.                          |
| NATS JetStream        | Leve e adequado; perde para o Redis apenas por ja termos o Redis.                                                             |
| Redis pub/sub simples | Sem persistencia nem ack: mensagem perdida quando o consumidor esta fora.                                                     |

## Consequencias

**Mais facil**: um componente a menos. O `make dev` sobe a plataforma inteira com
menos containers.

**Mais dificil**: o Redis passa a ser critico por dois motivos (orcamento e
eventos). O modo `budget_unverified` cobre a indisponibilidade no caminho de
inferencia; para eventos, a outbox segura o que nao foi publicado.

**Limite conhecido**: Redis Streams nao substitui Kafka em retencao longa. Se
surgir necessidade de reprocessar meses de historico, o port `EventPublisher`
permite trocar sem tocar em produtor nem consumidor.

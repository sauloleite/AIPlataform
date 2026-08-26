# ADR-008: Redis Streams and BullMQ for events and jobs

- **Status**: accepted (replaces Service Bus from the original ADR-008)
- **Date**: 2026-08-25

## Context

Reference doc 02 chose Azure Service Bus for business events and work queues,
with Event Hubs reserved for high-volume telemetry.

What the platform actually needs from a bus: at-least-once delivery, consumer
groups, explicit ack, visibility of pending messages for dead-lettering and
bounded retention.

Redis is already a MANDATORY dependency of the platform, because it is where the
atomic budget counter lives. Adding a separate broker would mean one more
component to operate, monitor and back up.

## Decision

- **Redis Streams** for business events: one stream per event type, a consumer
  group per service, explicit `XACK` and `XPENDING` for dead-lettering.
- **BullMQ** for work queues (ingestion, extraction, evaluation), which brings
  retry with backoff, priority and dead-lettering out of the box.
- **The outbox pattern** at the producer, always: the event is written to MongoDB
  alongside the state change, and a relay publishes it afterwards. That holds
  regardless of the broker.

## Alternatives considered

| Alternative         | Why not                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka / Redpanda    | Long retention and historical reprocessing are excellent, at the cost of operating a cluster. Disproportionate for the expected volume. |
| RabbitMQ            | Mature queue semantics, but one more stateful service to operate when Redis already covers it.                                          |
| NATS JetStream      | Light and suitable; it loses to Redis only because we already have Redis.                                                               |
| Plain Redis pub/sub | No persistence and no ack: a message is lost while the consumer is down.                                                                |

## Consequences

**Easier**: one component fewer. `make dev` brings the whole platform up with
fewer containers.

**Harder**: Redis becomes critical for two reasons (budget and events). The
`budget_unverified` mode covers unavailability on the inference path; for events,
the outbox holds whatever has not been published.

**Known limit**: Redis Streams does not replace Kafka for long retention. If a
need to reprocess months of history appears, the `EventPublisher` port allows the
swap without touching producer or consumer.

import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { EVENT_TYPES, MongoOutbox, newEvent } from '@aia/messaging';
import { currentRequestContext } from '@aia/nest';
import { usageRecordedPayload } from '../../domain/events/usage-recorded.js';
import type { UsageRecorded } from '../../domain/events/usage-recorded.js';
import type { UsagePublisher } from '../../application/ports.js';

const SOURCE = '/aia/inference-router';

/**
 * Publica `UsageRecorded` pela outbox.
 *
 * Escreve no MongoDB junto da auditoria; um relay separado leva para o
 * barramento. Publicar direto no Redis dentro do caminho da requisicao criaria
 * duas fontes de verdade quando a publicacao falha (doc 02, principio 3).
 */
@Injectable()
export class OutboxUsagePublisher implements UsagePublisher {
  private readonly outbox: MongoOutbox;

  constructor(db: Db) {
    this.outbox = new MongoOutbox(db);
  }

  async ensureIndexes(): Promise<void> {
    await this.outbox.ensureIndexes();
  }

  async publish(usage: UsageRecorded): Promise<void> {
    const traceparent = currentRequestContext()?.traceparent;

    await this.outbox.append([
      newEvent({
        type: EVENT_TYPES.USAGE_RECORDED,
        source: SOURCE,
        projectId: usage.projectId,
        time: usage.occurredAt,
        // O request_id deduplica: o consumidor pode reprocessar sem contar duas vezes.
        idempotencyKey: usage.requestId,
        ...(traceparent !== undefined && { traceparent }),
        data: usageRecordedPayload(usage),
      }),
    ]);
  }
}

import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { EVENT_TYPES, MongoOutbox, newEvent } from '@aia/messaging';
import { currentRequestContext } from '@aia/nest';
import { usageRecordedPayload } from '../../domain/events/usage-recorded.js';
import type { UsageRecorded } from '../../domain/events/usage-recorded.js';
import type { UsagePublisher } from '../../application/ports.js';

const SOURCE = '/aia/inference-router';

/**
 * Publishes `UsageRecorded` through the outbox.
 *
 * It writes to MongoDB alongside the audit record; a separate relay carries it
 * to the bus. Publishing straight to Redis inside the request path would create
 * two sources of truth whenever publishing failed (doc 02, principle 3).
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
        // request_id deduplicates: a consumer can reprocess without double counting.
        idempotencyKey: usage.requestId,
        ...(traceparent !== undefined && { traceparent }),
        data: usageRecordedPayload(usage),
      }),
    ]);
  }
}

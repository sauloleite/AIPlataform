import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { context, propagation } from '@opentelemetry/api';

import type { IngestionJobPayload, IngestionQueue } from '../../application/ports.js';

export const INGESTION_QUEUE_NAME = 'aia.knowledge.ingest';

/** BullMQ behind the IngestionQueue port (ADR-008). */
@Injectable()
export class BullMqIngestionQueue implements IngestionQueue {
  constructor(private readonly queue: Queue<IngestionJobPayload>) {}

  async enqueue(payload: IngestionJobPayload, idempotencyKey: string): Promise<void> {
    // Injected in the ADAPTER and not in the use case: which fields a trace
    // needs is the propagator's business, and the use case should not have to
    // know that a W3C header is involved at all.
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    await this.queue.add(
      'ingest',
      { ...payload, carrier },
      {
        // BullMQ drops a duplicate job id, so a client retrying the confirm call
        // does not enqueue the same work twice.
        jobId: idempotencyKey,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }
}

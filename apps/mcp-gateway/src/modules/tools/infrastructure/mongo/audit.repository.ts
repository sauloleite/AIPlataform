import { Injectable } from '@nestjs/common';
import type { CloudEvent } from '@aia/messaging';
import { MongoOutbox } from '@aia/messaging';
import type { Collection, Db, MongoClient } from 'mongodb';

import type { AuditRepository, InvocationRecord } from '../../application/ports.js';

interface InvocationDocument extends Omit<InvocationRecord, 'id'> {
  _id: string;
}

/**
 * Every invocation, with the identity that made it.
 *
 * Retention is enforced by the DATABASE through a TTL index, not by a job
 * somebody can forget to run (the same rule the router's audit follows).
 */
@Injectable()
export class MongoAuditRepository implements AuditRepository {
  private readonly collection: Collection<InvocationDocument>;
  private readonly outbox: MongoOutbox;

  constructor(
    private readonly client: MongoClient,
    db: Db,
    private readonly retentionDays: number,
  ) {
    this.collection = db.collection<InvocationDocument>('tool_invocations');
    this.outbox = new MongoOutbox(db);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ projectId: 1, occurredAt: -1 });
    await this.collection.createIndex({ projectId: 1, toolId: 1, occurredAt: -1 });
    await this.collection.createIndex({ principalId: 1, occurredAt: -1 });
    await this.collection.createIndex(
      { occurredAt: 1 },
      { expireAfterSeconds: this.retentionDays * 24 * 60 * 60 },
    );
    await this.outbox.ensureIndexes();
  }

  /** Record and event in the SAME transaction (outbox pattern). */
  async record(entry: InvocationRecord, events: readonly CloudEvent[] = []): Promise<void> {
    const { id, ...rest } = entry;
    const document: InvocationDocument = { _id: id, ...rest };

    if (events.length === 0) {
      await this.collection.insertOne(document);
      return;
    }

    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collection.insertOne(document, { session });
        await this.outbox.append([...events], session);
      });
    } finally {
      await session.endSession();
    }
  }
}

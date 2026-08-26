import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import type { AuditRecord, AuditRepository } from '../../application/ports.js';

interface AuditDocument extends Omit<AuditRecord, 'costMicros'> {
  _id: string;
  /** A string so int64 precision survives BSON. */
  costMicros: string;
}

/**
 * The inference audit trail.
 *
 * It records who called, which project, which deployment and in which DATA ZONE
 * the content was processed: that last column is what turns ADR-010 from an
 * intention into evidence.
 *
 * Prompt and response content only enters with the project's opt-in, and only
 * already redacted.
 */
@Injectable()
export class MongoAuditRepository implements AuditRepository {
  private readonly collection: Collection<AuditDocument>;

  constructor(
    db: Db,
    private readonly retentionDays: number,
  ) {
    this.collection = db.collection<AuditDocument>('inference_audit');
  }

  async ensureIndexes(): Promise<void> {
    // project_id first: every audit query is by tenant.
    await this.collection.createIndex({ projectId: 1, occurredAt: -1 });
    await this.collection.createIndex({ principalId: 1, occurredAt: -1 });
    await this.collection.createIndex({ dataZone: 1, occurredAt: -1 });
    await this.collection.createIndex(
      { occurredAt: 1 },
      { expireAfterSeconds: this.retentionDays * 24 * 60 * 60 },
    );
  }

  async record(entry: AuditRecord): Promise<void> {
    const { costMicros, ...rest } = entry;
    await this.collection.insertOne({
      _id: entry.requestId,
      ...rest,
      costMicros: costMicros.toString(),
    });
  }
}

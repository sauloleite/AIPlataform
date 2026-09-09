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
/** Named so it can be recognised, unlike the one it replaces. */
const EXPIRY_INDEX = 'audit_expiry_ttl';

@Injectable()
export class MongoAuditRepository implements AuditRepository {
  private readonly collection: Collection<AuditDocument>;

  constructor(db: Db) {
    this.collection = db.collection<AuditDocument>('inference_audit');
  }

  async ensureIndexes(): Promise<void> {
    // project_id first: every audit query is by tenant.
    await this.collection.createIndex({ projectId: 1, occurredAt: -1 });
    await this.collection.createIndex({ principalId: 1, occurredAt: -1 });
    await this.collection.createIndex({ dataZone: 1, occurredAt: -1 });

    // Expiry is on the DOCUMENT, so two projects can keep their records for
    // different lengths of time. A collection-wide TTL cannot: one index holds
    // one number, and retention is a project decision (doc 02 §10.2).
    await this.collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: EXPIRY_INDEX },
    );

    // The old collection-wide TTL has to go, or it keeps expiring records at
    // its own ninety days no matter what a project asked for -- and it would do
    // it silently, because a deleted audit record leaves nothing behind.
    await this.dropLegacyTtlIndex();
  }

  /**
   * Removes the TTL that used to live on `occurredAt`.
   *
   * Identified by its keys rather than by name, because it was created without
   * one and Mongo named it `occurredAt_1`. A plain index on `occurredAt` with
   * no `expireAfterSeconds` would be somebody's query index and is left alone.
   */
  private async dropLegacyTtlIndex(): Promise<void> {
    const indexes = await this.collection.indexes();
    for (const index of indexes) {
      const keys = Object.keys(index.key);
      const isTtlOnOccurredAt =
        keys.length === 1 && keys[0] === 'occurredAt' && index.expireAfterSeconds !== undefined;
      if (isTtlOnOccurredAt && index.name !== undefined) {
        await this.collection.dropIndex(index.name);
      }
    }
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

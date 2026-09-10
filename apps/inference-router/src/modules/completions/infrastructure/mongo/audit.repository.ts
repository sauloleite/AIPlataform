import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import type { AuditRecord, AuditRepository, StoredAuditRecord } from '../../application/ports.js';

interface AuditDocument extends Omit<AuditRecord, 'costMicros' | 'expiresAt'> {
  _id: string;
  /** A string so int64 precision survives BSON. */
  costMicros: string;
  /** Absent on every record written before per-project retention existed. */
  expiresAt?: Date;
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

/**
 * What a record written before per-project retention is given.
 *
 * The same 90 days the platform defaults to, and the same number those records
 * were written under when the TTL was collection-wide.
 */
const DEFAULT_RETENTION_DAYS = 90;

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
    await this.backfillExpiry();
  }

  /**
   * Gives an expiry to the records written before there was one.
   *
   * Without this they are immortal: the collection-wide TTL that used to expire
   * them is dropped above, and the per-document index only expires a document
   * that HAS `expiresAt`. Retention would then apply to everything written
   * after the upgrade and to nothing written before it -- silently, because a
   * record that is not deleted leaves no trace of not having been.
   *
   * Dated from `occurredAt` plus the platform default rather than the owning
   * project's setting: reading a policy per record would mean a call to
   * governance for every row at boot, and the default is the retention those
   * records were written under anyway.
   */
  private async backfillExpiry(): Promise<void> {
    const result = await this.collection.updateMany({ expiresAt: { $exists: false } }, [
      {
        $set: {
          expiresAt: {
            $add: ['$occurredAt', DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000],
          },
        },
      },
    ]);

    if (result.modifiedCount > 0) {
      // eslint-disable-next-line no-console -- runs at boot, before the logger.
      console.log(`audit: gave an expiry to ${result.modifiedCount} records written without one`);
    }
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

  async find(projectId: string, requestId: string): Promise<StoredAuditRecord | null> {
    const document = await this.collection.findOne({ _id: requestId, projectId });
    if (document === null) return null;

    const { _id, costMicros, ...rest } = document;
    return { ...rest, requestId: _id, costMicros: Number(costMicros) };
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

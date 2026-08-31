import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { StoreSubscriptionRepository } from '../../application/ports.js';

interface SubscriptionRecord {
  /** `${projectId}:${storeId}` -- the pair IS the identity, so it is the key. */
  _id: string;
  projectId: string;
  storeId: string;
  principalId: string;
  createdAt: Date;
}

function keyOf(projectId: string, storeId: string): string {
  return `${projectId}:${storeId}`;
}

/**
 * The consuming half of a shared store (ADR-023).
 *
 * A record here means a project ACCEPTED a published store. Its absence is a
 * refusal, which is why every read that grants access asks for it rather than
 * inferring it from the store being public.
 */
@Injectable()
export class MongoStoreSubscriptionRepository implements StoreSubscriptionRepository {
  private readonly collection: Collection<SubscriptionRecord>;

  constructor(db: Db) {
    this.collection = db.collection<SubscriptionRecord>('store_subscriptions');
  }

  async ensureIndexes(): Promise<void> {
    // The compound key is already unique as `_id`; these serve the two reads.
    await this.collection.createIndex({ projectId: 1, createdAt: -1 });
    await this.collection.createIndex({ storeId: 1 });
  }

  async isSubscribed(input: { projectId: string; storeId: string }): Promise<boolean> {
    const found = await this.collection.findOne(
      { _id: keyOf(input.projectId, input.storeId) },
      { projection: { _id: 1 } },
    );
    return found !== null;
  }

  async subscribe(input: {
    projectId: string;
    storeId: string;
    principalId: string;
    now: Date;
  }): Promise<void> {
    // Upsert rather than insert: subscribing twice is the same state, and a
    // duplicate-key error would make a retry look like a failure.
    await this.collection.updateOne(
      { _id: keyOf(input.projectId, input.storeId) },
      {
        $setOnInsert: {
          projectId: input.projectId,
          storeId: input.storeId,
          principalId: input.principalId,
          createdAt: input.now,
        },
      },
      { upsert: true },
    );
  }

  async unsubscribe(input: { projectId: string; storeId: string }): Promise<void> {
    await this.collection.deleteOne({ _id: keyOf(input.projectId, input.storeId) });
  }

  async listForProject(projectId: string): Promise<string[]> {
    const records = await this.collection
      .find({ projectId }, { projection: { storeId: 1 } })
      .toArray();
    return records.map((record) => record.storeId);
  }

  async removeForStore(storeId: string): Promise<void> {
    await this.collection.deleteMany({ storeId });
  }
}

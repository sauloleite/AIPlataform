import type { ClientSession, Collection, Db } from 'mongodb';
import type { CloudEvent } from './cloud-events.js';
import type { EventPublisher } from './ports.js';

/**
 * Outbox pattern (reference doc 02, principle 3).
 *
 * The event is written in the SAME transaction that changes the state. A
 * separate relay publishes whatever is pending. Without this, a crash between
 * "saved" and "published" leaves the system inconsistent — and a distributed
 * transaction would be worse.
 */
export interface OutboxRecord {
  _id: string;
  event: CloudEvent;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  createdAt: Date;
  publishedAt?: Date;
  lastError?: string;
  /** Optimistic lease held by the relay, so two replicas never publish the same event. */
  leasedUntil?: Date;
}

export const OUTBOX_COLLECTION = 'outbox';

export class MongoOutbox {
  private readonly collection: Collection<OutboxRecord>;

  constructor(db: Db, collectionName: string = OUTBOX_COLLECTION) {
    this.collection = db.collection<OutboxRecord>(collectionName);
  }

  /** Creates the indexes. Call this during service start-up. */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ status: 1, leasedUntil: 1, createdAt: 1 });
    // A published event need not live forever; analytics already received it.
    await this.collection.createIndex(
      { publishedAt: 1 },
      { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { status: 'published' } },
    );
  }

  /** Writes the event alongside the state change. Pass the transaction session. */
  async append(events: CloudEvent[], session?: ClientSession): Promise<void> {
    if (events.length === 0) return;
    const records: OutboxRecord[] = events.map((event) => ({
      _id: event.id,
      event,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    }));
    await this.collection.insertMany(records, {
      ...(session !== undefined && { session }),
      ordered: false,
    });
  }

  /** Leases up to `limit` pending events for `leaseMs`. */
  async lease(limit: number, leaseMs: number): Promise<OutboxRecord[]> {
    const now = new Date();
    const leasedUntil = new Date(now.getTime() + leaseMs);
    const leased: OutboxRecord[] = [];

    for (let i = 0; i < limit; i += 1) {
      const record = await this.collection.findOneAndUpdate(
        {
          status: 'pending',
          $or: [{ leasedUntil: { $exists: false } }, { leasedUntil: { $lt: now } }],
        },
        { $set: { leasedUntil }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (record === null) break;
      leased.push(record);
    }
    return leased;
  }

  async markPublished(id: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { status: 'published', publishedAt: new Date() }, $unset: { leasedUntil: '' } },
    );
  }

  async markFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    const record = await this.collection.findOne({ _id: id });
    const attempts = record?.attempts ?? 0;
    await this.collection.updateOne(
      { _id: id },
      {
        // After maxAttempts the event becomes `failed` and stops being retried:
        // it stays visible for investigation instead of spinning forever.
        $set: { status: attempts >= maxAttempts ? 'failed' : 'pending', lastError: error },
        $unset: { leasedUntil: '' },
      },
    );
  }

  async pendingCount(): Promise<number> {
    return this.collection.countDocuments({ status: 'pending' });
  }
}

export interface OutboxRelayOptions {
  batchSize?: number;
  intervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  onError?: (error: unknown, record: OutboxRecord) => void;
}

/** Reads the outbox and publishes. Runs as a sidecar or inside the service. */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly outbox: MongoOutbox,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions = {},
  ) {}

  async drain(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    const records = await this.outbox.lease(batchSize, this.options.leaseMs ?? 30_000);
    let published = 0;

    for (const record of records) {
      try {
        await this.publisher.publish(record.event);
        await this.outbox.markPublished(record._id);
        published += 1;
      } catch (error) {
        this.options.onError?.(error, record);
        await this.outbox.markFailed(
          record._id,
          error instanceof Error ? error.message : String(error),
          this.options.maxAttempts ?? 5,
        );
      }
    }
    return published;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (): void => {
      void this.drain().finally(() => {
        if (this.running) this.timer = setTimeout(tick, this.options.intervalMs ?? 1_000);
      });
    };
    tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

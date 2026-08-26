import type { ClientSession, Collection, Db } from 'mongodb';
import type { CloudEvent } from './cloud-events.js';
import type { EventPublisher } from './ports.js';

/**
 * Padrao Outbox (doc 02, principio 3).
 *
 * O evento e gravado na MESMA transacao que altera o estado. Um relay separado
 * publica o que esta pendente. Sem isso, um crash entre "salvou" e "publicou"
 * deixa o sistema inconsistente, e uma transacao distribuida seria pior.
 */
export interface OutboxRecord {
  _id: string;
  event: CloudEvent;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  createdAt: Date;
  publishedAt?: Date;
  lastError?: string;
  /** Reserva otimista do relay, para que duas replicas nao publiquem o mesmo evento. */
  leasedUntil?: Date;
}

export const OUTBOX_COLLECTION = 'outbox';

export class MongoOutbox {
  private readonly collection: Collection<OutboxRecord>;

  constructor(db: Db, collectionName: string = OUTBOX_COLLECTION) {
    this.collection = db.collection<OutboxRecord>(collectionName);
  }

  /** Cria os indices. Chame na inicializacao do servico. */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ status: 1, leasedUntil: 1, createdAt: 1 });
    // Evento publicado nao precisa ficar para sempre; o analitico ja recebeu.
    await this.collection.createIndex(
      { publishedAt: 1 },
      { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { status: 'published' } },
    );
  }

  /** Grava o evento junto da mudanca de estado. Passe a sessao da transacao. */
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

  /** Reserva ate `limit` eventos pendentes por `leaseMs`. */
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
        // Depois de maxAttempts o evento vira `failed` e para de ser tentado:
        // fica visivel para investigacao em vez de girar para sempre.
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

/** Le a outbox e publica. Roda como sidecar ou como tarefa do proprio servico. */
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

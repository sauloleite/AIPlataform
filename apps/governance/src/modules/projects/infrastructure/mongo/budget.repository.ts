import { Injectable } from '@nestjs/common';
import type { Collection, Db, MongoClient } from 'mongodb';
import { MongoOutbox, type CloudEvent } from '@aia/messaging';
import { Budget, type BudgetPeriod } from '../../domain/entities/budget.js';
import { Money } from '../../domain/value-objects/money.js';
import type { BudgetRepository } from '../../application/ports.js';

interface BudgetDocument {
  _id: string;
  currency: string;
  /** Armazenado como string para nao perder precisao de int64 em JSON/BSON. */
  limitMicros: string;
  spentMicros: string;
  reservedMicros: string;
  period: BudgetPeriod;
  periodStart: Date;
  blockAtLimit: boolean;
  alertThresholds: number[];
}

function toEntity(document: BudgetDocument): Budget {
  return Budget.rehydrate({
    projectId: document._id,
    limit: Money.of(BigInt(document.limitMicros), document.currency),
    spent: Money.of(BigInt(document.spentMicros), document.currency),
    reserved: Money.of(BigInt(document.reservedMicros), document.currency),
    period: document.period,
    periodStart: document.periodStart,
    blockAtLimit: document.blockAtLimit,
    alertThresholds: document.alertThresholds,
  });
}

@Injectable()
export class MongoBudgetRepository implements BudgetRepository {
  private readonly collection: Collection<BudgetDocument>;
  private readonly outbox: MongoOutbox;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.collection = db.collection<BudgetDocument>('budgets');
    this.outbox = new MongoOutbox(db);
  }

  async findByProject(projectId: string): Promise<Budget | null> {
    const document = await this.collection.findOne({ _id: projectId });
    return document === null ? null : toEntity(document);
  }

  async save(budget: Budget, events: CloudEvent[] = []): Promise<void> {
    const snapshot = budget.toSnapshot();
    const document: Omit<BudgetDocument, '_id'> = {
      currency: snapshot.limit.currency,
      limitMicros: snapshot.limit.micros.toString(),
      spentMicros: snapshot.spent.micros.toString(),
      reservedMicros: snapshot.reserved.micros.toString(),
      period: snapshot.period,
      periodStart: snapshot.periodStart,
      blockAtLimit: snapshot.blockAtLimit,
      alertThresholds: snapshot.alertThresholds,
    };

    if (events.length === 0) {
      await this.collection.updateOne(
        { _id: snapshot.projectId },
        { $set: document },
        { upsert: true },
      );
      return;
    }

    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collection.updateOne(
          { _id: snapshot.projectId },
          { $set: document },
          { upsert: true, session },
        );
        await this.outbox.append(events, session);
      });
    } finally {
      await session.endSession();
    }
  }
}

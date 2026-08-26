import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import type { AuditRecord, AuditRepository } from '../../application/ports.js';

interface AuditDocument extends Omit<AuditRecord, 'costMicros'> {
  _id: string;
  /** String para nao perder precisao de int64 em BSON. */
  costMicros: string;
}

/**
 * Trilha de auditoria de inferencia.
 *
 * Guarda quem chamou, qual projeto, qual deployment e em qual ZONA DE DADOS o
 * conteudo foi processado: e essa ultima coluna que transforma o ADR-010 de
 * intencao em evidencia.
 *
 * Conteudo de prompt e resposta so entra com opt-in do projeto, e ja redigido.
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
    // project_id primeiro: toda consulta de auditoria e por tenant.
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

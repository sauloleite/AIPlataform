import { Injectable } from '@nestjs/common';
import type { CloudEvent } from '@aia/messaging';
import { MongoOutbox } from '@aia/messaging';
import type { Collection, Db, Filter, MongoClient } from 'mongodb';

import {
  Document,
  type DocumentProps,
  type IngestionStatus,
} from '../../domain/entities/document.js';
import { DocumentAcl } from '../../domain/value-objects/document-acl.js';
import type { DocumentPage, DocumentRepository } from '../../application/ports.js';

interface DocumentRecord {
  _id: string;
  projectId: string;
  storeId: string;
  title: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  version: number;
  status: IngestionStatus;
  errorCode?: string;
  chunkCount: number;
  aclPublic: boolean;
  aclGroups: string[];
  aclPrincipals: string[];
  ownerPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
  ingestedAt?: Date;
}

function toEntity(record: DocumentRecord): Document {
  const props: DocumentProps = {
    id: record._id,
    projectId: record.projectId,
    storeId: record.storeId,
    title: record.title,
    objectKey: record.objectKey,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    ...(record.contentHash !== undefined && { contentHash: record.contentHash }),
    version: record.version,
    status: record.status,
    ...(record.errorCode !== undefined && { errorCode: record.errorCode }),
    chunkCount: record.chunkCount,
    acl: DocumentAcl.of({
      isPublic: record.aclPublic,
      groups: record.aclGroups,
      principals: record.aclPrincipals,
    }),
    ownerPrincipalId: record.ownerPrincipalId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.ingestedAt !== undefined && { ingestedAt: record.ingestedAt }),
  };
  return Document.rehydrate(props);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (iso === undefined || id === undefined) return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

@Injectable()
export class MongoDocumentRepository implements DocumentRepository {
  private readonly collection: Collection<DocumentRecord>;
  private readonly outbox: MongoOutbox;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.collection = db.collection<DocumentRecord>('documents');
    this.outbox = new MongoOutbox(db);
  }

  async ensureIndexes(): Promise<void> {
    // Idempotency by content hash: identical bytes in one store are one
    // document. Partial, because a document exists BEFORE it is hashed and a
    // plain unique index would collide on every unhashed row.
    await this.collection.createIndex(
      { storeId: 1, contentHash: 1 },
      { unique: true, partialFilterExpression: { contentHash: { $type: 'string' } } },
    );
    await this.collection.createIndex({ projectId: 1, storeId: 1, createdAt: -1, _id: -1 });
    await this.collection.createIndex({ objectKey: 1 }, { unique: true });
    await this.collection.createIndex({ projectId: 1, status: 1 });
    await this.outbox.ensureIndexes();
  }

  async findById(projectId: string, documentId: string): Promise<Document | null> {
    const record = await this.collection.findOne({ _id: documentId, projectId });
    return record === null ? null : toEntity(record);
  }

  async findByContentHash(storeId: string, contentHash: string): Promise<Document | null> {
    const record = await this.collection.findOne({ storeId, contentHash });
    return record === null ? null : toEntity(record);
  }

  async countByStore(
    projectId: string,
    storeIds: readonly string[],
  ): Promise<Record<string, number>> {
    if (storeIds.length === 0) return {};

    const rows = await this.collection
      .aggregate<{ _id: string; count: number }>([
        { $match: { projectId, storeId: { $in: [...storeIds] } } },
        { $group: { _id: '$storeId', count: { $sum: 1 } } },
      ])
      .toArray();

    const counts: Record<string, number> = {};
    for (const storeId of storeIds) counts[storeId] = 0;
    for (const row of rows) counts[row._id] = row.count;
    return counts;
  }

  async list(input: {
    projectId: string;
    storeId: string;
    limit: number;
    cursor?: string;
  }): Promise<DocumentPage> {
    const filter: Filter<DocumentRecord> = {
      projectId: input.projectId,
      storeId: input.storeId,
    };
    const decoded = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (decoded !== null) {
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }

    const records = await this.collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .toArray();

    const hasMore = records.length > input.limit;
    const page = hasMore ? records.slice(0, input.limit) : records;
    const last = page.at(-1);

    return {
      items: page.map(toEntity),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  /** State and events in the SAME transaction (outbox pattern). */
  async save(document: Document, events: readonly CloudEvent[] = []): Promise<void> {
    const snapshot = document.snapshot();
    const acl = snapshot.acl;
    const record: DocumentRecord = {
      _id: snapshot.id,
      projectId: snapshot.projectId,
      storeId: snapshot.storeId,
      title: snapshot.title,
      objectKey: snapshot.objectKey,
      mimeType: snapshot.mimeType,
      sizeBytes: snapshot.sizeBytes,
      ...(snapshot.contentHash !== undefined && { contentHash: snapshot.contentHash }),
      version: snapshot.version,
      status: snapshot.status,
      ...(snapshot.errorCode !== undefined && { errorCode: snapshot.errorCode }),
      chunkCount: snapshot.chunkCount,
      aclPublic: acl.isPublic,
      aclGroups: [...acl.groups],
      aclPrincipals: [...acl.principals],
      ownerPrincipalId: snapshot.ownerPrincipalId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      ...(snapshot.ingestedAt !== undefined && { ingestedAt: snapshot.ingestedAt }),
    };
    const { _id, ...rest } = record;

    // Cleared fields must be REMOVED, not merely omitted: a $set of the
    // remaining keys leaves the previous value in place, so a document that
    // recovered from a failure would keep its old error code.
    const cleared: Record<string, ''> = {};
    if (snapshot.contentHash === undefined) cleared['contentHash'] = '';
    if (snapshot.errorCode === undefined) cleared['errorCode'] = '';
    if (snapshot.ingestedAt === undefined) cleared['ingestedAt'] = '';
    const unset = Object.keys(cleared).length > 0 ? { $unset: cleared } : {};

    if (events.length === 0) {
      await this.collection.updateOne({ _id }, { $set: rest, ...unset }, { upsert: true });
      return;
    }

    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collection.updateOne(
          { _id },
          { $set: rest, ...unset },
          { upsert: true, session },
        );
        await this.outbox.append([...events], session);
      });
    } finally {
      await session.endSession();
    }
  }

  async remove(documentId: string): Promise<void> {
    await this.collection.deleteOne({ _id: documentId });
  }

  async removeForStore(storeId: string): Promise<void> {
    await this.collection.deleteMany({ storeId });
  }
}

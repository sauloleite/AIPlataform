import { Injectable } from '@nestjs/common';
import type { Collection, Db, Filter } from 'mongodb';

import {
  VectorStore,
  type StoreVisibility,
  type VectorStoreProps,
} from '../../domain/entities/vector-store.js';
import { ChunkingStrategy, type ChunkKind } from '../../domain/value-objects/chunking-strategy.js';
import type { StorePage, VectorStoreRepository } from '../../application/ports.js';

interface StoreDocument {
  _id: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  embeddingAlias: string;
  embeddingModel: string;
  dimensions: number;
  distance: 'cosine' | 'dot';
  chunking: { kind: ChunkKind; maxTokens: number; overlapTokens: number };
  collectionName: string;
  documentCount: number;
  visibility?: StoreVisibility;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(document: StoreDocument): VectorStore {
  const props: VectorStoreProps = {
    id: document._id,
    projectId: document.projectId,
    slug: document.slug,
    name: document.name,
    ...(document.description !== undefined && { description: document.description }),
    embeddingAlias: document.embeddingAlias,
    embeddingModel: document.embeddingModel,
    dimensions: document.dimensions,
    distance: document.distance,
    chunking: ChunkingStrategy.of(document.chunking),
    collectionName: document.collectionName,
    documentCount: document.documentCount,
    // Absent on a store written before sharing existed. Private is the only
    // safe reading of silence.
    visibility: document.visibility ?? 'private',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  return VectorStore.rehydrate(props);
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
export class MongoStoreRepository implements VectorStoreRepository {
  private readonly collection: Collection<StoreDocument>;

  constructor(db: Db) {
    this.collection = db.collection<StoreDocument>('vector_stores');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ projectId: 1, slug: 1 }, { unique: true });
    await this.collection.createIndex({ projectId: 1, createdAt: -1, _id: -1 });
    // The catalogue reads published stores across every project, so its index
    // leads with visibility rather than with the tenant.
    await this.collection.createIndex({ visibility: 1, createdAt: -1, _id: -1 });
  }

  async findById(projectId: string, storeId: string): Promise<VectorStore | null> {
    // projectId is part of the query, not a check afterwards.
    const document = await this.collection.findOne({ _id: storeId, projectId });
    return document === null ? null : toEntity(document);
  }

  async findByIdAcrossProjects(storeId: string): Promise<VectorStore | null> {
    // No tenant in the query, by design and by the port's name. The caller
    // owes an `accessTo` decision before it may do anything with the result.
    const document = await this.collection.findOne({ _id: storeId });
    return document === null ? null : toEntity(document);
  }

  async findBySlug(projectId: string, slug: string): Promise<VectorStore | null> {
    const document = await this.collection.findOne({ projectId, slug });
    return document === null ? null : toEntity(document);
  }

  async list(input: { projectId: string; limit: number; cursor?: string }): Promise<StorePage> {
    const filter: Filter<StoreDocument> = { projectId: input.projectId };
    const decoded = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (decoded !== null) {
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }

    const documents = await this.collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .toArray();

    const hasMore = documents.length > input.limit;
    const page = hasMore ? documents.slice(0, input.limit) : documents;
    const last = page.at(-1);

    return {
      items: page.map(toEntity),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  async listPublic(input: {
    excludingProjectId: string;
    limit: number;
    cursor?: string;
  }): Promise<StorePage> {
    // A project's own stores are already on its own list; showing them again
    // in the catalogue would offer somebody a subscription to themselves.
    const filter: Filter<StoreDocument> = {
      visibility: 'public',
      projectId: { $ne: input.excludingProjectId },
    };
    const decoded = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (decoded !== null) {
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }

    const documents = await this.collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .toArray();

    const hasMore = documents.length > input.limit;
    const page = hasMore ? documents.slice(0, input.limit) : documents;
    const last = page.at(-1);

    return {
      items: page.map(toEntity),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  async save(store: VectorStore): Promise<void> {
    const snapshot = store.snapshot();
    const document: StoreDocument = {
      _id: snapshot.id,
      projectId: snapshot.projectId,
      slug: snapshot.slug,
      name: snapshot.name,
      ...(snapshot.description !== undefined && { description: snapshot.description }),
      embeddingAlias: snapshot.embeddingAlias,
      embeddingModel: snapshot.embeddingModel,
      dimensions: snapshot.dimensions,
      distance: snapshot.distance,
      chunking: {
        kind: snapshot.chunking.kind,
        maxTokens: snapshot.chunking.maxTokens,
        overlapTokens: snapshot.chunking.overlapTokens,
      },
      collectionName: snapshot.collectionName,
      visibility: snapshot.visibility,
      documentCount: snapshot.documentCount,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    const { _id, ...rest } = document;
    await this.collection.updateOne({ _id }, { $set: rest }, { upsert: true });
  }

  async remove(projectId: string, storeId: string): Promise<void> {
    await this.collection.deleteOne({ _id: storeId, projectId });
  }
}

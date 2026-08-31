import { Injectable } from '@nestjs/common';
import type { CloudEvent } from '@aia/messaging';
import { MongoOutbox } from '@aia/messaging';
import type { Collection, Db, Filter, MongoClient } from 'mongodb';

import { Asset, type AssetProps } from '../../domain/entities/asset.js';
import type { AssetKind } from '../../domain/value-objects/index.js';
import type { AssetPage, AssetRepository } from '../../application/ports.js';

interface AssetDocument {
  _id: string;
  projectId: string;
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  ownerPrincipalId: string;
  publishedVersion?: number;
  draftVersion?: number;
  latestVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(document: AssetDocument): Asset {
  const props: AssetProps = {
    id: document._id,
    projectId: document.projectId,
    kind: document.kind,
    slug: document.slug,
    name: document.name,
    ...(document.description !== undefined && { description: document.description }),
    ownerPrincipalId: document.ownerPrincipalId,
    ...(document.publishedVersion !== undefined && { publishedVersion: document.publishedVersion }),
    ...(document.draftVersion !== undefined && { draftVersion: document.draftVersion }),
    latestVersion: document.latestVersion,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  return Asset.rehydrate(props);
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

/**
 * Which optional fields must be REMOVED from the document.
 *
 * Omitting a field from `$set` does not clear it -- the old value stays. So an
 * asset that just cleared its draft would still read as having one, which is
 * how a freshly published agent came to look like it had pending changes.
 *
 * Exported so this decision is testable without a database.
 */
export function fieldsToUnset(snapshot: {
  publishedVersion?: number;
  draftVersion?: number;
  description?: string;
}): Record<string, ''> {
  const cleared: Record<string, ''> = {};
  if (snapshot.publishedVersion === undefined) cleared['publishedVersion'] = '';
  if (snapshot.draftVersion === undefined) cleared['draftVersion'] = '';
  if (snapshot.description === undefined) cleared['description'] = '';
  return cleared;
}

@Injectable()
export class MongoAssetRepository implements AssetRepository {
  private readonly collection: Collection<AssetDocument>;
  private readonly outbox: MongoOutbox;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.collection = db.collection<AssetDocument>('assets');
    this.outbox = new MongoOutbox(db);
  }

  async ensureIndexes(): Promise<void> {
    // Unique per project AND kind: a tool may share a name with an agent, and
    // another tenant may use the same name entirely.
    await this.collection.createIndex({ projectId: 1, kind: 1, slug: 1 }, { unique: true });
    await this.collection.createIndex({ projectId: 1, createdAt: -1, _id: -1 });
    await this.outbox.ensureIndexes();
  }

  async findById(projectId: string, assetId: string): Promise<Asset | null> {
    // projectId is part of the query, not a check afterwards: a filter applied
    // after the read is a filter somebody eventually forgets.
    const document = await this.collection.findOne({ _id: assetId, projectId });
    return document === null ? null : toEntity(document);
  }

  async findBySlug(projectId: string, kind: AssetKind, slug: string): Promise<Asset | null> {
    const document = await this.collection.findOne({ projectId, kind, slug });
    return document === null ? null : toEntity(document);
  }

  async list(input: {
    projectId: string;
    kind?: AssetKind;
    limit: number;
    cursor?: string;
  }): Promise<AssetPage> {
    const filter: Filter<AssetDocument> = { projectId: input.projectId };
    if (input.kind !== undefined) filter.kind = input.kind;

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

  /** State and events in the SAME transaction (outbox pattern). */
  async save(asset: Asset, events: readonly CloudEvent[] = []): Promise<void> {
    const snapshot = asset.snapshot();
    const document: AssetDocument = {
      _id: snapshot.id,
      projectId: snapshot.projectId,
      kind: snapshot.kind,
      slug: snapshot.slug,
      name: snapshot.name,
      ...(snapshot.description !== undefined && { description: snapshot.description }),
      ownerPrincipalId: snapshot.ownerPrincipalId,
      ...(snapshot.publishedVersion !== undefined && {
        publishedVersion: snapshot.publishedVersion,
      }),
      ...(snapshot.draftVersion !== undefined && { draftVersion: snapshot.draftVersion }),
      latestVersion: snapshot.latestVersion,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    const { _id, ...rest } = document;

    const cleared = fieldsToUnset(snapshot);
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
}

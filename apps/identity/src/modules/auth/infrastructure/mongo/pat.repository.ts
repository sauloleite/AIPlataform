import { Injectable } from '@nestjs/common';
import type { Collection, Db, Filter } from 'mongodb';
import { PersonalAccessToken, type PatProps } from '../../domain/entities/personal-access-token.js';
import { TokenScopes } from '../../domain/value-objects/token-scopes.js';
import type { PatRepository } from '../../application/ports.js';

interface PatDocument {
  _id: string;
  name: string;
  principalId: string;
  projectId: string;
  tokenHash: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

function toEntity(document: PatDocument): PersonalAccessToken {
  const props: PatProps = {
    id: document._id,
    name: document.name,
    principalId: document.principalId,
    projectId: document.projectId,
    tokenHash: document.tokenHash,
    scopes: TokenScopes.of(document.scopes),
    createdAt: document.createdAt,
    expiresAt: document.expiresAt,
    ...(document.lastUsedAt !== undefined && { lastUsedAt: document.lastUsedAt }),
    ...(document.revokedAt !== undefined && { revokedAt: document.revokedAt }),
  };
  return PersonalAccessToken.rehydrate(props);
}

/** Opaque cursor: base64 of `createdAt|id`. Clients must not interpret it. */
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
export class MongoPatRepository implements PatRepository {
  private readonly collection: Collection<PatDocument>;

  constructor(db: Db) {
    this.collection = db.collection<PatDocument>('personal_access_tokens');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ tokenHash: 1 }, { unique: true });
    await this.collection.createIndex({ principalId: 1, createdAt: -1, _id: -1 });
    // Expired for more than 30 days is not even useful for usage audit.
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
  }

  async findById(id: string): Promise<PersonalAccessToken | null> {
    const document = await this.collection.findOne({ _id: id });
    return document === null ? null : toEntity(document);
  }

  async findByHash(tokenHash: string): Promise<PersonalAccessToken | null> {
    const document = await this.collection.findOne({ tokenHash });
    return document === null ? null : toEntity(document);
  }

  async listByPrincipal(
    principalId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: PersonalAccessToken[]; nextCursor: string | null }> {
    const filter: Filter<PatDocument> = { principalId };
    const decoded = cursor === undefined ? null : decodeCursor(cursor);
    if (decoded !== null) {
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }

    // Fetch one extra to learn whether a next page exists without a separate count.
    const documents = await this.collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = documents.length > limit;
    const page = hasMore ? documents.slice(0, limit) : documents;
    const last = page.at(-1);

    return {
      items: page.map(toEntity),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  async save(pat: PersonalAccessToken): Promise<void> {
    const snapshot = pat.toSnapshot();
    const { id, scopes, ...rest } = snapshot;
    await this.collection.updateOne(
      { _id: id },
      { $set: { ...rest, scopes: scopes.toArray() } },
      { upsert: true },
    );
  }
}

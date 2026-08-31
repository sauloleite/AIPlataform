import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { AssetVersion, type AssetVersionProps } from '../../domain/entities/asset-version.js';
import type { AssetDefinition, VersionStatus } from '../../domain/value-objects/index.js';
import type { VersionRepository } from '../../application/ports.js';

interface VersionDocument {
  _id: string;
  assetId: string;
  version: number;
  status: VersionStatus;
  definition: AssetDefinition;
  revision: number;
  publishedAt?: Date;
  publishedBy?: string;
  updatedAt: Date;
}

function keyOf(assetId: string, version: number): string {
  return `${assetId}:${version.toString()}`;
}

function toEntity(document: VersionDocument): AssetVersion {
  const props: AssetVersionProps = {
    assetId: document.assetId,
    version: document.version,
    status: document.status,
    definition: document.definition,
    revision: document.revision,
    ...(document.publishedAt !== undefined && { publishedAt: document.publishedAt }),
    ...(document.publishedBy !== undefined && { publishedBy: document.publishedBy }),
    updatedAt: document.updatedAt,
  };
  return AssetVersion.rehydrate(props);
}

@Injectable()
export class MongoVersionRepository implements VersionRepository {
  private readonly collection: Collection<VersionDocument>;

  constructor(db: Db) {
    this.collection = db.collection<VersionDocument>('asset_versions');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ assetId: 1, version: 1 }, { unique: true });
  }

  async find(assetId: string, version: number): Promise<AssetVersion | null> {
    const document = await this.collection.findOne({ _id: keyOf(assetId, version) });
    return document === null ? null : toEntity(document);
  }

  async listForAsset(assetId: string): Promise<AssetVersion[]> {
    const documents = await this.collection.find({ assetId }).sort({ version: 1 }).toArray();
    return documents.map(toEntity);
  }

  async save(version: AssetVersion): Promise<void> {
    const snapshot = version.snapshot();
    const document: VersionDocument = {
      _id: keyOf(snapshot.assetId, snapshot.version),
      assetId: snapshot.assetId,
      version: snapshot.version,
      status: snapshot.status,
      definition: snapshot.definition,
      revision: snapshot.revision,
      ...(snapshot.publishedAt !== undefined && { publishedAt: snapshot.publishedAt }),
      ...(snapshot.publishedBy !== undefined && { publishedBy: snapshot.publishedBy }),
      updatedAt: snapshot.updatedAt,
    };
    const { _id, ...rest } = document;
    await this.collection.updateOne({ _id }, { $set: rest }, { upsert: true });
  }
}

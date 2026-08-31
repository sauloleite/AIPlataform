import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { Connection, type ConnectionKind } from '../../domain/entities/connection.js';
import type { ConnectionRepository } from '../../application/ports.js';

/**
 * Connections in Mongo.
 *
 * Note what the document does NOT have: a field for the secret. There is
 * nowhere to put one, which is a stronger guarantee than remembering not to
 * (ADR-015). A dump of this collection hands over endpoint names and nothing
 * that opens them.
 */
interface ConnectionDocument {
  _id: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  header: string;
  secretRef: string;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(document: ConnectionDocument): Connection {
  return Connection.rehydrate({
    id: document._id,
    projectId: document.projectId,
    slug: document.slug,
    name: document.name,
    ...(document.description !== undefined && { description: document.description }),
    kind: document.kind,
    header: document.header,
    secretRef: document.secretRef,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
}

@Injectable()
export class MongoConnectionRepository implements ConnectionRepository {
  private readonly collection: Collection<ConnectionDocument>;

  constructor(db: Db) {
    this.collection = db.collection<ConnectionDocument>('connections');
  }

  async ensureIndexes(): Promise<void> {
    // Unique per project: a slug is how a person refers to a connection, and
    // two meaning different things is how the wrong credential gets attached.
    await this.collection.createIndex({ projectId: 1, slug: 1 }, { unique: true });
  }

  async find(projectId: string, connectionId: string): Promise<Connection | null> {
    const document = await this.collection.findOne({ _id: connectionId, projectId });
    return document === null ? null : toEntity(document);
  }

  async findBySlug(projectId: string, slug: string): Promise<Connection | null> {
    const document = await this.collection.findOne({ projectId, slug });
    return document === null ? null : toEntity(document);
  }

  async list(projectId: string): Promise<Connection[]> {
    const documents = await this.collection.find({ projectId }).sort({ slug: 1 }).toArray();
    return documents.map(toEntity);
  }

  async save(connection: Connection): Promise<void> {
    const snapshot = connection.snapshot;
    await this.collection.updateOne(
      { _id: snapshot.id },
      {
        $set: {
          projectId: snapshot.projectId,
          slug: snapshot.slug,
          name: snapshot.name,
          kind: snapshot.kind,
          header: snapshot.header,
          secretRef: snapshot.secretRef,
          updatedAt: snapshot.updatedAt,
          ...(snapshot.description !== undefined && { description: snapshot.description }),
        },
        $setOnInsert: { createdAt: snapshot.createdAt },
        // A description cleared in the UI has to be cleared in the document;
        // `$set` alone leaves the old one in place.
        ...(snapshot.description === undefined && { $unset: { description: '' } }),
      },
      { upsert: true },
    );
  }

  async remove(projectId: string, connectionId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: connectionId, projectId });
    return result.deletedCount === 1;
  }
}

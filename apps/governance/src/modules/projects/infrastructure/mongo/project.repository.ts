import { Injectable } from '@nestjs/common';
import type { Collection, Db, Filter, MongoClient } from 'mongodb';
import type { CloudEvent } from '@aia/messaging';
import { MongoOutbox } from '@aia/messaging';
import { Project, type ModelRule, type ProjectProps } from '../../domain/entities/project.js';
import {
  DataClassification,
  type ClassificationLevel,
  type DataZone,
} from '../../domain/value-objects/data-classification.js';
import type { ProjectRepository } from '../../application/ports.js';

interface ProjectDocument {
  _id: string;
  slug: string;
  name: string;
  description?: string;
  classification: ClassificationLevel;
  legalBasis: string;
  purpose: string;
  costCenter?: string;
  ownerPrincipalId?: string;
  allowedZones: DataZone[];
  modelRules: ModelRule[];
  maxConcurrentRequests: number;
  contentCapture: boolean;
  /** Absent on a project written before retention became a policy field. */
  contentRetentionDays?: number;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(document: ProjectDocument): Project {
  const props: ProjectProps = {
    id: document._id,
    slug: document.slug,
    name: document.name,
    ...(document.description !== undefined && { description: document.description }),
    classification: DataClassification.of(document.classification),
    legalBasis: document.legalBasis,
    purpose: document.purpose,
    ...(document.costCenter !== undefined && { costCenter: document.costCenter }),
    ...(document.ownerPrincipalId !== undefined && { ownerPrincipalId: document.ownerPrincipalId }),
    allowedZones: document.allowedZones,
    modelRules: document.modelRules,
    maxConcurrentRequests: document.maxConcurrentRequests,
    // The default rather than a crash: a project stored before this field
    // existed keeps the ninety days it already had (doc 02 §10.2).
    contentRetentionDays: document.contentRetentionDays ?? 90,
    contentCapture: document.contentCapture,
    policyVersion: document.policyVersion,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  return Project.rehydrate(props);
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
export class MongoProjectRepository implements ProjectRepository {
  private readonly collection: Collection<ProjectDocument>;
  private readonly outbox: MongoOutbox;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.collection = db.collection<ProjectDocument>('projects');
    this.outbox = new MongoOutbox(db);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ slug: 1 }, { unique: true });
    await this.collection.createIndex({ createdAt: -1, _id: -1 });
    await this.outbox.ensureIndexes();
  }

  async findById(id: string): Promise<Project | null> {
    const document = await this.collection.findOne({ _id: id });
    return document === null ? null : toEntity(document);
  }

  async findBySlug(slug: string): Promise<Project | null> {
    const document = await this.collection.findOne({ slug });
    return document === null ? null : toEntity(document);
  }

  async list(input: { limit: number; cursor?: string }): Promise<{
    items: Project[];
    nextCursor: string | null;
  }> {
    const filter: Filter<ProjectDocument> = {};
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

  /**
   * State and events in the SAME transaction (outbox pattern).
   *
   * Without a transaction, a crash between the `updateOne` and the `append`
   * would publish an event about state that does not exist, or lose the event
   * for state that does.
   */
  async save(project: Project, events: CloudEvent[] = []): Promise<void> {
    const snapshot = project.toSnapshot();
    const document: ProjectDocument = {
      _id: snapshot.id,
      slug: snapshot.slug,
      name: snapshot.name,
      ...(snapshot.description !== undefined && { description: snapshot.description }),
      classification: snapshot.classification.level,
      legalBasis: snapshot.legalBasis,
      purpose: snapshot.purpose,
      ...(snapshot.costCenter !== undefined && { costCenter: snapshot.costCenter }),
      ...(snapshot.ownerPrincipalId !== undefined && {
        ownerPrincipalId: snapshot.ownerPrincipalId,
      }),
      allowedZones: snapshot.allowedZones,
      modelRules: snapshot.modelRules,
      maxConcurrentRequests: snapshot.maxConcurrentRequests,
      contentCapture: snapshot.contentCapture,
      policyVersion: snapshot.policyVersion,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    const { _id, ...rest } = document;

    if (events.length === 0) {
      await this.collection.updateOne({ _id }, { $set: rest }, { upsert: true });
      return;
    }

    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collection.updateOne({ _id }, { $set: rest }, { upsert: true, session });
        await this.outbox.append(events, session);
      });
    } finally {
      await session.endSession();
    }
  }
}

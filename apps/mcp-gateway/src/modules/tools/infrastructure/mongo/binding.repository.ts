import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { ToolBinding, type ToolBindingProps } from '../../domain/entities/tool-binding.js';
import type { BindingRepository } from '../../application/ports.js';

interface BindingDocument {
  _id: string;
  projectId: string;
  toolId: string;
  enabled: boolean;
  rateLimitPerMinute?: number;
  requireApproval?: boolean;
  updatedAt: Date;
}

function keyOf(projectId: string, toolId: string): string {
  return `${projectId}:${toolId}`;
}

function toEntity(document: BindingDocument): ToolBinding {
  const props: ToolBindingProps = {
    projectId: document.projectId,
    toolId: document.toolId,
    enabled: document.enabled,
    ...(document.rateLimitPerMinute !== undefined && {
      rateLimitPerMinute: document.rateLimitPerMinute,
    }),
    ...(document.requireApproval !== undefined && { requireApproval: document.requireApproval }),
    updatedAt: document.updatedAt,
  };
  return ToolBinding.rehydrate(props);
}

@Injectable()
export class MongoBindingRepository implements BindingRepository {
  private readonly collection: Collection<BindingDocument>;

  constructor(db: Db) {
    this.collection = db.collection<BindingDocument>('tool_bindings');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ projectId: 1, toolId: 1 }, { unique: true });
  }

  async find(projectId: string, toolId: string): Promise<ToolBinding | null> {
    const document = await this.collection.findOne({ _id: keyOf(projectId, toolId) });
    return document === null ? null : toEntity(document);
  }

  async list(projectId: string): Promise<ToolBinding[]> {
    const documents = await this.collection.find({ projectId }).toArray();
    return documents.map(toEntity);
  }

  async save(binding: ToolBinding): Promise<void> {
    const snapshot = binding.snapshot();
    const document: BindingDocument = {
      _id: keyOf(snapshot.projectId, snapshot.toolId),
      projectId: snapshot.projectId,
      toolId: snapshot.toolId,
      enabled: snapshot.enabled,
      ...(snapshot.rateLimitPerMinute !== undefined && {
        rateLimitPerMinute: snapshot.rateLimitPerMinute,
      }),
      ...(snapshot.requireApproval !== undefined && { requireApproval: snapshot.requireApproval }),
      updatedAt: snapshot.updatedAt,
    };
    const { _id, ...rest } = document;

    // Cleared options must be REMOVED: a $set of the remaining keys would keep
    // a rate limit somebody has just taken off.
    const cleared: Record<string, ''> = {};
    if (snapshot.rateLimitPerMinute === undefined) cleared['rateLimitPerMinute'] = '';
    if (snapshot.requireApproval === undefined) cleared['requireApproval'] = '';
    const unset = Object.keys(cleared).length > 0 ? { $unset: cleared } : {};

    await this.collection.updateOne({ _id }, { $set: rest, ...unset }, { upsert: true });
  }

  async remove(projectId: string, toolId: string): Promise<void> {
    await this.collection.deleteOne({ _id: keyOf(projectId, toolId) });
  }
}

import type { Document } from '../domain/entities/document.js';
import type { VectorStore } from '../domain/entities/vector-store.js';
import type { DocumentView, StoreView } from './dto.js';

export function storeView(store: VectorStore): StoreView {
  const props = store.snapshot();
  return {
    id: props.id,
    projectId: props.projectId,
    visibility: props.visibility,
    slug: props.slug,
    name: props.name,
    ...(props.description !== undefined && { description: props.description }),
    embeddingAlias: props.embeddingAlias,
    embeddingModel: props.embeddingModel,
    dimensions: props.dimensions,
    chunking: {
      kind: props.chunking.kind,
      maxTokens: props.chunking.maxTokens,
      overlapTokens: props.chunking.overlapTokens,
    },
    documentCount: props.documentCount,
    createdAt: props.createdAt.toISOString(),
    updatedAt: props.updatedAt.toISOString(),
  };
}

export function documentView(document: Document): DocumentView {
  const props = document.snapshot();
  const acl = props.acl;
  return {
    id: props.id,
    storeId: props.storeId,
    title: props.title,
    mimeType: props.mimeType,
    sizeBytes: props.sizeBytes,
    contentHash: props.contentHash ?? null,
    version: props.version,
    status: props.status,
    errorCode: props.errorCode ?? null,
    chunkCount: props.chunkCount,
    acl: {
      public: acl.isPublic,
      groups: [...acl.groups],
      principals: [...acl.principals],
    },
    createdAt: props.createdAt.toISOString(),
    ingestedAt: props.ingestedAt?.toISOString() ?? null,
  };
}

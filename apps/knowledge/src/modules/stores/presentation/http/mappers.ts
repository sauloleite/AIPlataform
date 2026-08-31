import type {
  DocumentView,
  SearchHitView,
  StoreView,
  UploadTicketView,
} from '../../application/dto.js';

/**
 * Application views translated into the shape the contract publishes.
 *
 * The application layer names things the way TypeScript does; the wire is
 * snake_case because `contracts/openapi/knowledge.v1.yaml` says so, and the
 * contract is the source. Serialising a view straight out of a controller ties
 * an external API to an internal field name — rename the field and every client
 * breaks silently.
 */

export function toStoreResponse(store: StoreView): Record<string, unknown> {
  return {
    id: store.id,
    project_id: store.projectId,
    visibility: store.visibility,
    ...(store.access !== undefined && { access: store.access }),
    ...(store.subscribed !== undefined && { subscribed: store.subscribed }),
    slug: store.slug,
    name: store.name,
    ...(store.description !== undefined && { description: store.description }),
    embedding_alias: store.embeddingAlias,
    embedding_model: store.embeddingModel,
    dimensions: store.dimensions,
    chunking: {
      kind: store.chunking.kind,
      max_tokens: store.chunking.maxTokens,
      overlap_tokens: store.chunking.overlapTokens,
    },
    document_count: store.documentCount,
    created_at: store.createdAt,
    updated_at: store.updatedAt,
  };
}

export function toDocumentResponse(document: DocumentView): Record<string, unknown> {
  return {
    id: document.id,
    store_id: document.storeId,
    title: document.title,
    mime_type: document.mimeType,
    size_bytes: document.sizeBytes,
    content_hash: document.contentHash,
    version: document.version,
    status: document.status,
    error_code: document.errorCode,
    chunk_count: document.chunkCount,
    acl: {
      public: document.acl.public,
      groups: document.acl.groups,
      principals: document.acl.principals,
    },
    created_at: document.createdAt,
    ingested_at: document.ingestedAt,
  };
}

export function toUploadTicketResponse(ticket: UploadTicketView): Record<string, unknown> {
  return {
    document: toDocumentResponse(ticket.document),
    upload_url: ticket.uploadUrl,
    expires_at: ticket.expiresAt,
  };
}

export function toSearchHitResponse(hit: SearchHitView): Record<string, unknown> {
  return {
    document_id: hit.documentId,
    document_title: hit.documentTitle,
    chunk_index: hit.chunkIndex,
    score: hit.score,
    retrieval: hit.retrieval,
    // Absent rather than null when only the lexical ranking reached the chunk:
    // there is no cosine to report, and a zero would read as a bad match.
    ...(hit.vectorScore !== undefined && { vector_score: hit.vectorScore }),
    text: hit.text,
  };
}

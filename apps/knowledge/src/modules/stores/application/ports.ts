/**
 * Application layer ports.
 *
 * Interfaces plus a Symbol for the Nest token. A use case knows that vectors
 * can be searched and that bytes can be read; it never knows Qdrant or MinIO.
 */
import type { CloudEvent } from '@aia/messaging';

import type { Document } from '../domain/entities/document.js';
import type { VectorStore } from '../domain/entities/vector-store.js';
import type { Chunk } from '../domain/services/chunker.js';
import type { TrimmingSpec } from '../domain/services/security-trimming.js';

/* ------------------------------------------------------------------ */
/* Vector index                                                        */
/* ------------------------------------------------------------------ */

export interface VectorPoint {
  /** Deterministic: same bytes, same chunk, same id. See IngestDocument. */
  id: string;
  vector: number[];
  projectId: string;
  storeId: string;
  documentId: string;
  version: number;
  chunkIndex: number;
  acl: { acl_public: boolean; acl_groups: string[]; acl_principals: string[] };
}

export interface VectorMatch {
  documentId: string;
  chunkIndex: number;
  score: number;
}

/**
 * The vector index, behind a port (ADR-006: swapping Qdrant for pgvector or a
 * managed search service must not touch a use case).
 *
 * `search` takes a TrimmingSpec, not an optional filter. An implementation
 * that ignored it would leak across tenants, so it is not optional in the
 * signature and there is no overload without it.
 */
export interface VectorIndex {
  ensureCollection(input: {
    name: string;
    dimensions: number;
    distance: 'cosine' | 'dot';
  }): Promise<void>;
  upsert(collection: string, points: readonly VectorPoint[]): Promise<void>;
  search(input: {
    collection: string;
    vector: readonly number[];
    limit: number;
    trimming: TrimmingSpec;
    minScore?: number;
  }): Promise<VectorMatch[]>;
  /** Drops the vectors a superseded version left behind. */
  deleteOtherVersions(input: {
    collection: string;
    projectId: string;
    documentId: string;
    keepVersion: number;
  }): Promise<void>;
  deleteDocument(input: {
    collection: string;
    projectId: string;
    documentId: string;
  }): Promise<void>;
}
export const VECTOR_INDEX = Symbol('VectorIndex');

/* ------------------------------------------------------------------ */
/* Object storage                                                      */
/* ------------------------------------------------------------------ */

export interface ObjectStore {
  ensureBucket(bucket: string): Promise<void>;
  /** Presigned PUT: the document never passes through this service. */
  presignUpload(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;
  stat(input: { bucket: string; key: string }): Promise<{ sizeBytes: number } | null>;
  /** A stream, not a Buffer: a large PDF must not be resident in the worker. */
  open(input: { bucket: string; key: string }): Promise<NodeJS.ReadableStream>;
  remove(input: { bucket: string; key: string }): Promise<void>;
}
export const OBJECT_STORE = Symbol('ObjectStore');

/* ------------------------------------------------------------------ */
/* Embeddings                                                          */
/* ------------------------------------------------------------------ */

export interface EmbeddingBatch {
  vectors: number[][];
  /** The provider model the alias actually resolved to. */
  model: string;
}

/**
 * Embeddings through aia-inference-router, never straight to a provider: that
 * is what keeps budget, data-classification routing and audit applying to
 * ingestion exactly as they apply to chat.
 */
export interface EmbeddingClient {
  embed(input: {
    projectId: string;
    accessToken: string;
    alias: string;
    texts: readonly string[];
  }): Promise<EmbeddingBatch>;
  /** Largest batch the adapter will send; the use case splits on it. */
  readonly maxBatchSize: number;
}
export const EMBEDDING_CLIENT = Symbol('EmbeddingClient');

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export interface ParsedDocument {
  /** Markdown, per flow 7.3. */
  markdown: string;
}

export interface DocumentParser {
  supports(mimeType: string): boolean;
  parse(input: { stream: NodeJS.ReadableStream; mimeType: string }): Promise<ParsedDocument>;
}
/** Injected as an ARRAY: which parsers exist depends on what is configured. */
export const DOCUMENT_PARSERS = Symbol('DocumentParsers');

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export interface IngestionJobPayload {
  projectId: string;
  storeId: string;
  documentId: string;
  /** Embeddings are charged to the project, as the uploader. */
  accessToken: string;
}

export interface IngestionQueue {
  enqueue(payload: IngestionJobPayload, idempotencyKey: string): Promise<void>;
}
export const INGESTION_QUEUE = Symbol('IngestionQueue');

/* ------------------------------------------------------------------ */
/* Repositories                                                        */
/* ------------------------------------------------------------------ */

export interface StorePage {
  items: VectorStore[];
  nextCursor: string | null;
}

export interface VectorStoreRepository {
  findById(projectId: string, storeId: string): Promise<VectorStore | null>;
  /**
   * Resolves a store whoever owns it.
   *
   * Deliberately long-winded: this is the ONE read that does not carry a
   * tenant, and every caller has to feed the result through `accessTo` before
   * doing anything with it. Reaching for it because `findById` returned null
   * is how a shared-store feature becomes a cross-tenant read.
   */
  findByIdAcrossProjects(storeId: string): Promise<VectorStore | null>;
  findBySlug(projectId: string, slug: string): Promise<VectorStore | null>;
  list(input: { projectId: string; limit: number; cursor?: string }): Promise<StorePage>;
  /** The catalogue: published stores owned by somebody else (ADR-023). */
  listPublic(input: {
    excludingProjectId: string;
    limit: number;
    cursor?: string;
  }): Promise<StorePage>;
  save(store: VectorStore): Promise<void>;
  remove(projectId: string, storeId: string): Promise<void>;
}
export const STORE_REPOSITORY = Symbol('VectorStoreRepository');

/**
 * Which projects have accepted which published stores (ADR-023).
 *
 * The consuming half of the two consents. Kept apart from the store because it
 * belongs to the subscriber, not to the owner: an owner who withdraws a store
 * should not be silently editing other projects' records.
 */
export interface StoreSubscriptionRepository {
  isSubscribed(input: { projectId: string; storeId: string }): Promise<boolean>;
  subscribe(input: {
    projectId: string;
    storeId: string;
    principalId: string;
    now: Date;
  }): Promise<void>;
  unsubscribe(input: { projectId: string; storeId: string }): Promise<void>;
  /** Store ids this project has accepted, for the store list. */
  listForProject(projectId: string): Promise<string[]>;
  /** Every subscription to a store, dropped when it is deleted or withdrawn. */
  removeForStore(storeId: string): Promise<void>;
}
export const STORE_SUBSCRIPTION_REPOSITORY = Symbol('StoreSubscriptionRepository');

export interface DocumentPage {
  items: Document[];
  nextCursor: string | null;
}

export interface DocumentRepository {
  findById(projectId: string, documentId: string): Promise<Document | null>;
  findByContentHash(storeId: string, contentHash: string): Promise<Document | null>;
  /**
   * How many documents each store holds.
   *
   * Counted rather than kept on the store: a denormalised counter drifts the
   * first time an upload fails halfway, and a wrong count on a list page is
   * the kind of thing nobody notices until it matters.
   */
  countByStore(projectId: string, storeIds: readonly string[]): Promise<Record<string, number>>;
  list(input: {
    projectId: string;
    storeId: string;
    limit: number;
    cursor?: string;
  }): Promise<DocumentPage>;
  /** State and events in one transaction: the outbox pattern. */
  save(document: Document, events?: readonly CloudEvent[]): Promise<void>;
  remove(documentId: string): Promise<void>;
  removeForStore(storeId: string): Promise<void>;
}
export const DOCUMENT_REPOSITORY = Symbol('DocumentRepository');

export interface StoredChunk {
  documentId: string;
  version: number;
  index: number;
  text: string;
}

/** A chunk the lexical ranking reached, in rank order. */
export interface TextMatch {
  documentId: string;
  chunkIndex: number;
  /** The engine's own relevance score. Reported, never compared to a cosine. */
  score: number;
}

/**
 * Chunk TEXT lives in Mongo, not in the vector payload.
 *
 * A lean payload is a fast filter, and the filter runs on every search. It
 * also means the only sensitive thing in the vector index is the ACL, not the
 * document body.
 *
 * The same collection carries the lexical half of hybrid search. It is one
 * store of chunk text with two reads over it, not two stores: splitting the
 * port would mean two adapters owning one collection, and the second one to
 * change would be the one that drifts.
 */
export interface ChunkRepository {
  replaceForDocument(input: {
    documentId: string;
    projectId: string;
    /** Denormalised from the document so the lexical filter can be complete. */
    storeId: string;
    acl: { acl_public: boolean; acl_groups: string[]; acl_principals: string[] };
    version: number;
    chunks: readonly Chunk[];
  }): Promise<void>;
  findMany(input: {
    projectId: string;
    documentId: string;
    version: number;
    indexes: readonly number[];
  }): Promise<StoredChunk[]>;
  /**
   * The lexical ranking, trimmed by the same spec the vector index gets.
   *
   * It takes a TrimmingSpec rather than an optional filter for the reason
   * VectorIndex.search does: an implementation that ignored it would leak
   * across tenants, so the signature does not offer the option.
   */
  searchText(input: { trimming: TrimmingSpec; query: string; limit: number }): Promise<TextMatch[]>;
  removeForDocument(documentId: string): Promise<void>;
  removeForStore(storeId: string): Promise<void>;
}
export const CHUNK_REPOSITORY = Symbol('ChunkRepository');

/** The bucket documents live in. A wiring value, injected like any other. */
export const KNOWLEDGE_BUCKET = Symbol('KnowledgeBucket');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
  /** Stable across retries, so replaying a job upserts rather than duplicates. */
  forChunk(input: { storeId: string; contentHash: string; index: number }): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

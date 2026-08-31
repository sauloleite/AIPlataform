import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EVENT_TYPES, newEvent } from '@aia/messaging';

import type { Document } from '../../domain/entities/document.js';
import {
  DocumentNotFoundError,
  EmbeddingDimensionMismatchError,
  StoreNotFoundError,
  UnsupportedMediaTypeError,
} from '../../domain/errors/index.js';
import { splitIntoChunks, type Chunk } from '../../domain/services/chunker.js';
import type { VectorStore } from '../../domain/entities/vector-store.js';
import {
  STORE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  CHUNK_REPOSITORY,
  OBJECT_STORE,
  DOCUMENT_PARSERS,
  EMBEDDING_CLIENT,
  VECTOR_INDEX,
  KNOWLEDGE_BUCKET,
  CLOCK,
  ID_GENERATOR,
  type ChunkRepository,
  type Clock,
  type DocumentParser,
  type DocumentRepository,
  type EmbeddingClient,
  type IdGenerator,
  type IngestionJobPayload,
  type ObjectStore,
  type VectorIndex,
  type VectorPoint,
  type VectorStoreRepository,
} from '../ports.js';

const SOURCE = 'aia-knowledge';

/**
 * Flow 7.3, end to end: parse, chunk, embed, index.
 *
 * Runs in the worker, not in the API. Every failure marks the document
 * `failed` with a stable code rather than leaving it stuck mid-pipeline, so
 * the console can always say what happened.
 */
@Injectable()
export class IngestDocument {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(CHUNK_REPOSITORY) private readonly chunks: ChunkRepository,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(DOCUMENT_PARSERS) private readonly parsers: readonly DocumentParser[],
    @Inject(EMBEDDING_CLIENT) private readonly embeddings: EmbeddingClient,
    @Inject(VECTOR_INDEX) private readonly index: VectorIndex,
    @Inject(KNOWLEDGE_BUCKET) private readonly bucket: string,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(payload: IngestionJobPayload): Promise<void> {
    const document = await this.documents.findById(payload.projectId, payload.documentId);
    if (document === null) throw new DocumentNotFoundError(payload.documentId);

    const store = await this.stores.findById(payload.projectId, payload.storeId);
    if (store === null) throw new StoreNotFoundError(payload.storeId, payload.projectId);

    try {
      await this.run(store, document, payload);
    } catch (error) {
      const code = codeOf(error);
      document.fail(code, this.clock.now());
      await this.documents.save(document, [
        newEvent({
          type: EVENT_TYPES.INGESTION_FAILED,
          source: SOURCE,
          projectId: payload.projectId,
          data: { document_id: document.id, store_id: store.id, error_code: code },
        }),
      ]);
      throw error;
    }
  }

  private async run(
    store: VectorStore,
    document: Document,
    payload: IngestionJobPayload,
  ): Promise<void> {
    const now = (): Date => this.clock.now();

    document.advance('parsing', now());
    await this.documents.save(document);

    const parser = this.parsers.find((candidate) => candidate.supports(document.mimeType));
    if (parser === undefined) throw new UnsupportedMediaTypeError(document.mimeType);

    // Hash while parsing, in one pass: a large PDF must not be read twice.
    const stream = await this.objects.open({ bucket: this.bucket, key: document.objectKey });
    const hasher = createHash('sha256');
    stream.on('data', (piece: Buffer | string) => hasher.update(piece));
    const parsed = await parser.parse({ stream, mimeType: document.mimeType });
    const contentHash = hasher.digest('hex');

    // Identical bytes already in this store: nothing to embed again.
    const twin = await this.documents.findByContentHash(store.id, contentHash);
    if (twin !== null && twin.id !== document.id) {
      document.markIngested({ contentHash, chunkCount: twin.chunkCount, now: now() });
      await this.documents.save(document, [this.ingestedEvent(store, document)]);
      return;
    }

    document.advance('chunking', now());
    await this.documents.save(document);
    const chunks = splitIntoChunks(parsed.markdown, store.chunking);

    document.advance('embedding', now());
    await this.documents.save(document);
    const vectors = await this.embedAll(store, chunks, payload);

    document.advance('indexing', now());
    await this.documents.save(document);

    const version = document.version;
    await this.chunks.replaceForDocument({
      documentId: document.id,
      projectId: store.projectId,
      // The store and the ACL are copied onto every chunk so the lexical
      // ranking can filter on exactly what the vector payload filters on.
      storeId: store.id,
      acl: document.acl.toPayload(),
      version,
      chunks,
    });

    const points: VectorPoint[] = chunks.map((chunk, position) => ({
      id: this.ids.forChunk({ storeId: store.id, contentHash, index: chunk.index }),
      vector: vectors[position] ?? [],
      projectId: store.projectId,
      storeId: store.id,
      documentId: document.id,
      version,
      chunkIndex: chunk.index,
      acl: document.acl.toPayload(),
    }));

    // The new version lands BEFORE the old one is dropped, so a search during
    // reindexing never sees the document disappear.
    await this.index.upsert(store.collectionName, points);
    await this.index.deleteOtherVersions({
      collection: store.collectionName,
      projectId: store.projectId,
      documentId: document.id,
      keepVersion: version,
    });

    document.markIngested({ contentHash, chunkCount: chunks.length, now: now() });
    await this.documents.save(document, [this.ingestedEvent(store, document)]);
  }

  private async embedAll(
    store: VectorStore,
    chunks: readonly Chunk[],
    payload: IngestionJobPayload,
  ): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let start = 0; start < chunks.length; start += this.embeddings.maxBatchSize) {
      const batch = chunks.slice(start, start + this.embeddings.maxBatchSize);
      const result = await this.embeddings.embed({
        projectId: store.projectId,
        accessToken: payload.accessToken,
        alias: store.embeddingAlias,
        texts: batch.map((chunk) => chunk.text),
      });

      for (const vector of result.vectors) {
        // The router may fail over between deployments within one alias, and a
        // different provider means a different width. Writing that in would
        // corrupt the index silently; a failed job is loud.
        if (vector.length !== store.dimensions) {
          throw new EmbeddingDimensionMismatchError(store.dimensions, vector.length);
        }
        vectors.push(vector);
      }
    }

    return vectors;
  }

  private ingestedEvent(
    store: VectorStore,
    document: Document,
  ): ReturnType<typeof newEvent<Record<string, unknown>>> {
    return newEvent({
      type: EVENT_TYPES.DOCUMENT_INGESTED,
      source: SOURCE,
      projectId: store.projectId,
      data: {
        document_id: document.id,
        store_id: store.id,
        chunk_count: document.chunkCount,
        version: document.version,
      },
    });
  }
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'ingestion_failed';
}

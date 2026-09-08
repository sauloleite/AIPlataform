import { createHash, randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Client as MinioClient } from 'minio';
import { Db, MongoClient } from 'mongodb';

import { CONFIG, type KnowledgeConfig } from '../../config/index.js';
import {
  CHUNK_REPOSITORY,
  CLOCK,
  DOCUMENT_PARSERS,
  DOCUMENT_REPOSITORY,
  EMBEDDING_CLIENT,
  ID_GENERATOR,
  INGESTION_QUEUE,
  OBJECT_STORE,
  KNOWLEDGE_BUCKET,
  STORE_REPOSITORY,
  STORE_SUBSCRIPTION_REPOSITORY,
  VECTOR_INDEX,
  type ChunkRepository,
  type Clock,
  type DocumentParser,
  type DocumentRepository,
  type EmbeddingClient,
  type IdGenerator,
  type IngestionJobPayload,
  type IngestionQueue,
  type ObjectStore,
  type VectorIndex,
  type StoreSubscriptionRepository,
  type VectorStoreRepository,
} from './application/ports.js';
import { CompleteDocumentUpload } from './application/use-cases/complete-upload.js';
import { CreateStore } from './application/use-cases/create-store.js';
import { IngestDocument } from './application/use-cases/ingest-document.js';
import {
  DeleteDocument,
  DeleteStore,
  GetStore,
  ListDocuments,
  ListStores,
} from './application/use-cases/manage-stores.js';
import { RegisterDocument } from './application/use-cases/register-document.js';
import { SearchStore } from './application/use-cases/search-store.js';
import {
  ChangeStoreVisibility,
  ListStoreCatalogue,
  ResolveReadableStore,
  SubscribeToStore,
  UnsubscribeFromStore,
} from './application/use-cases/share-store.js';
import { HttpEmbeddingClient } from './infrastructure/http/http-embedding-client.js';
import { MinioObjectStore } from './infrastructure/minio/minio-object-store.js';
import { MongoChunkRepository } from './infrastructure/mongo/chunk.repository.js';
import { MongoDocumentRepository } from './infrastructure/mongo/document.repository.js';
import { MongoStoreRepository } from './infrastructure/mongo/store.repository.js';
import { MongoStoreSubscriptionRepository } from './infrastructure/mongo/store-subscription.repository.js';
import { TextParser } from './infrastructure/parsers/text-parser.js';
import { BullMqIngestionQueue, INGESTION_QUEUE_NAME } from './infrastructure/queue/bullmq-queue.js';
import { QdrantVectorIndex } from './infrastructure/qdrant/qdrant-vector-index.js';
import { StoresController } from './presentation/http/stores.controller.js';

/** Wiring: the only place that knows all three layers at once. */
const adapters: Provider[] = [
  { provide: CLOCK, useValue: { now: (): Date => new Date() } satisfies Clock },
  {
    provide: ID_GENERATOR,
    useValue: {
      next: (): string => randomUUID(),
      // Deterministic: replaying a job upserts the same points rather than
      // duplicating them, which is what makes at-least-once delivery survivable
      // without a transaction across Mongo, Qdrant and object storage.
      forChunk: (input): string => {
        // Qdrant point ids must be a UUID or an unsigned integer, so the hash
        // is formatted as one. It is derived, not random: replaying a job
        // upserts the same points instead of duplicating them.
        const hex = createHash('sha256')
          .update(`${input.storeId}:${input.contentHash}:${input.index.toString()}`)
          .digest('hex')
          .slice(0, 32);
        return [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20, 32),
        ].join('-');
      },
    } satisfies IdGenerator,
  },
  {
    provide: KNOWLEDGE_BUCKET,
    useFactory: (config: KnowledgeConfig): string => config.KNOWLEDGE_BUCKET,
    inject: [CONFIG],
  },
  {
    provide: QdrantClient,
    useFactory: (config: KnowledgeConfig): QdrantClient =>
      new QdrantClient({
        url: config.QDRANT_URL,
        ...(config.QDRANT_API_KEY !== undefined && { apiKey: config.QDRANT_API_KEY }),
      }),
    inject: [CONFIG],
  },
  {
    provide: VECTOR_INDEX,
    useFactory: (client: QdrantClient): VectorIndex => new QdrantVectorIndex(client),
    inject: [QdrantClient],
  },
  {
    provide: MinioClient,
    useFactory: (config: KnowledgeConfig): MinioClient => {
      const endpoint = new URL(config.MINIO_ENDPOINT);
      return new MinioClient({
        endPoint: endpoint.hostname,
        port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
        useSSL: endpoint.protocol === 'https:',
        accessKey: config.MINIO_ROOT_USER,
        secretKey: config.MINIO_ROOT_PASSWORD,
      });
    },
    inject: [CONFIG],
  },
  {
    provide: OBJECT_STORE,
    useFactory: (client: MinioClient): ObjectStore => new MinioObjectStore(client),
    inject: [MinioClient],
  },
  {
    provide: EMBEDDING_CLIENT,
    useFactory: (config: KnowledgeConfig): EmbeddingClient =>
      new HttpEmbeddingClient(config.INFERENCE_ROUTER_URL, config.EMBEDDING_BATCH_SIZE),
    inject: [CONFIG],
  },
  {
    // An array, because which parsers exist depends on what is configured. A
    // missing document-processing service disables those types, exactly as a
    // missing provider key disables one provider.
    provide: DOCUMENT_PARSERS,
    useFactory: (): DocumentParser[] => [new TextParser()],
  },
  {
    provide: Queue,
    useFactory: (config: KnowledgeConfig): Queue<IngestionJobPayload> =>
      new Queue<IngestionJobPayload>(INGESTION_QUEUE_NAME, {
        connection: { url: config.REDIS_URL },
      }),
    inject: [CONFIG],
  },
  {
    provide: INGESTION_QUEUE,
    useFactory: (queue: Queue<IngestionJobPayload>): IngestionQueue =>
      new BullMqIngestionQueue(queue),
    inject: [Queue],
  },
  {
    provide: STORE_REPOSITORY,
    useFactory: (db: Db): VectorStoreRepository => new MongoStoreRepository(db),
    inject: [Db],
  },
  {
    provide: STORE_SUBSCRIPTION_REPOSITORY,
    useFactory: (db: Db): StoreSubscriptionRepository => new MongoStoreSubscriptionRepository(db),
    inject: [Db],
  },
  {
    provide: DOCUMENT_REPOSITORY,
    useFactory: (client: MongoClient, db: Db): DocumentRepository =>
      new MongoDocumentRepository(client, db),
    inject: [MongoClient, Db],
  },
  {
    provide: CHUNK_REPOSITORY,
    useFactory: (db: Db): ChunkRepository => new MongoChunkRepository(db),
    inject: [Db],
  },
  {
    provide: HEALTH_CHECKS,
    useFactory: (db: Db, redis: Redis, qdrant: QdrantClient): DependencyCheck[] => [
      {
        name: 'mongodb',
        critical: true,
        check: async () => {
          await db.command({ ping: 1 });
          return { status: 'ok' as const };
        },
      },
      {
        name: 'redis',
        critical: true,
        check: async () => {
          await redis.ping();
          return { status: 'ok' as const };
        },
      },
      {
        // Critical: without the index there is nothing to search, and a store
        // that accepts uploads it cannot index is worse than a clear 503.
        name: 'qdrant',
        critical: true,
        check: async () => {
          await qdrant.getCollections();
          return { status: 'ok' as const };
        },
      },
    ],
    inject: [Db, Redis, QdrantClient],
  },
];

// Plain class providers: the use cases declare their collaborators with
// @Inject on the constructor, the way the router's do. A factory per use case
// would only restate the same list.
const useCases: Provider[] = [
  CreateStore,
  ListStores,
  GetStore,
  RegisterDocument,
  CompleteDocumentUpload,
  ListDocuments,
  DeleteDocument,
  DeleteStore,
  SearchStore,
  ChangeStoreVisibility,
  SubscribeToStore,
  UnsubscribeFromStore,
  ListStoreCatalogue,
  ResolveReadableStore,
  // Used by the worker entrypoint, not by any controller.
  IngestDocument,
];

@Module({
  controllers: [StoresController, HealthController],
  providers: [...adapters, ...useCases],
  exports: [
    IngestDocument,
    STORE_REPOSITORY,
    STORE_SUBSCRIPTION_REPOSITORY,
    DOCUMENT_REPOSITORY,
    CHUNK_REPOSITORY,
    OBJECT_STORE,
    VECTOR_INDEX,
    KNOWLEDGE_BUCKET,
  ],
})
export class StoresModule {}

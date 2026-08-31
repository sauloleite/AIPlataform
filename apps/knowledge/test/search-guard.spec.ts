import { describe, expect, it } from 'vitest';

import { SearchStore } from '../src/modules/stores/application/use-cases/search-store.js';
import { VectorStore } from '../src/modules/stores/domain/entities/vector-store.js';
import { ChunkingStrategy } from '../src/modules/stores/domain/value-objects/chunking-strategy.js';
import { EmbeddingDimensionMismatchError } from '../src/modules/stores/domain/errors/index.js';
import type {
  ChunkRepository,
  DocumentRepository,
  EmbeddingClient,
  StoreSubscriptionRepository,
  VectorIndex,
  VectorStoreRepository,
} from '../src/modules/stores/application/ports.js';

const NOW = new Date('2026-08-27T00:00:00Z');

const store = VectorStore.create({
  id: 's1',
  projectId: 'p1',
  slug: 'handbook',
  name: 'Handbook',
  embeddingAlias: 'embedding-default',
  embeddingModel: 'gemini-embedding-001',
  dimensions: 3072,
  chunking: ChunkingStrategy.default(),
  now: NOW,
});

const stores = {
  findById: () => Promise.resolve(store),
  findByIdAcrossProjects: () => Promise.resolve(store),
} as unknown as VectorStoreRepository;

/** Never consulted: the caller owns the store in these tests. */
const subscriptions = {
  isSubscribed: () => Promise.reject(new Error('the owner must not be asked to subscribe')),
} as unknown as StoreSubscriptionRepository;

const documents = {} as DocumentRepository;
const chunks = {} as ChunkRepository;

/** Never reached in these tests: the guard fires first. */
const index = {
  search: () => {
    throw new Error('the index must not be queried with a mismatched vector');
  },
} as unknown as VectorIndex;

function embeddingOf(width: number): EmbeddingClient {
  return {
    maxBatchSize: 16,
    embed: () =>
      Promise.resolve({ vectors: [Array.from({ length: width }, () => 0.1)], model: 'whatever' }),
  };
}

function search(width: number): Promise<unknown> {
  return new SearchStore(
    stores,
    subscriptions,
    documents,
    chunks,
    embeddingOf(width),
    index,
  ).execute({
    projectId: 'p1',
    storeId: 's1',
    principalId: 'user-1',
    principalGroups: [],
    accessToken: 'token',
    query: 'anything',
    topK: 5,
  });
}

describe('search with a store whose model changed underneath it', () => {
  /**
   * An alias can resolve to a different provider than the one the store was
   * built with -- a key expires, a deployment falls over, a local model stands
   * in. The query vector is then the wrong width, and without this guard it
   * reaches the index and comes back as an opaque 500.
   */
  it('refuses a query vector narrower than the store', async () => {
    await expect(search(768)).rejects.toThrow(EmbeddingDimensionMismatchError);
  });

  it('refuses a query vector wider than the store', async () => {
    await expect(search(4096)).rejects.toThrow(EmbeddingDimensionMismatchError);
  });

  it('names both widths, so the cause is legible', async () => {
    await expect(search(768)).rejects.toMatchObject({
      code: 'embedding_dimension_mismatch',
      details: { expected_dimensions: 3072, actual_dimensions: 768 },
    });
  });
});

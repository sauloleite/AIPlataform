import { describe, expect, it } from 'vitest';

import { DeleteStore } from '../src/modules/stores/application/use-cases/manage-stores.js';
import { VectorStore } from '../src/modules/stores/domain/entities/vector-store.js';
import { Document } from '../src/modules/stores/domain/entities/document.js';
import { ChunkingStrategy } from '../src/modules/stores/domain/value-objects/chunking-strategy.js';
import { DocumentAcl } from '../src/modules/stores/domain/value-objects/document-acl.js';
import { StoreNotFoundError } from '../src/modules/stores/domain/errors/index.js';
import type {
  ChunkRepository,
  DocumentRepository,
  ObjectStore,
  StoreSubscriptionRepository,
  VectorIndex,
  VectorStoreRepository,
} from '../src/modules/stores/application/ports.js';

const NOW = new Date('2026-09-08T00:00:00Z');
const BUCKET = 'aia-knowledge';

function storeIn(projectId: string, id: string): VectorStore {
  return VectorStore.create({
    id,
    projectId,
    slug: `slug-${id}`,
    name: id,
    embeddingAlias: 'embedding-default',
    embeddingModel: 'fake',
    dimensions: 4,
    chunking: ChunkingStrategy.default(),
    now: NOW,
  });
}

function documentIn(storeId: string, id: string): Document {
  return Document.register({
    id,
    projectId: 'p1',
    storeId,
    title: id,
    objectKey: `p1/${storeId}/${id}`,
    mimeType: 'text/plain',
    sizeBytes: 10,
    acl: DocumentAcl.publicToProject(),
    ownerPrincipalId: 'user-1',
    now: NOW,
  });
}

/** Every call the use case makes, in the order it made them. */
type Trace = string[];

interface World {
  deleteStore: DeleteStore;
  trace: Trace;
  vectors: { storeId: string; projectId: string }[];
  storesLeft: Set<string>;
  subscriptionsLeft: Set<string>;
  objectsLeft: Set<string>;
}

function build(options: { documents?: Document[]; objectStoreFails?: boolean } = {}): World {
  const trace: Trace = [];
  const documents = options.documents ?? [documentIn('s1', 'd1'), documentIn('s1', 'd2')];

  // Two stores share one collection, which is the shape ADR-016 produces: one
  // collection per embedding SHAPE, not per store.
  const vectors = [
    { storeId: 's1', projectId: 'p1' },
    { storeId: 's1', projectId: 'p1' },
    { storeId: 's2', projectId: 'p1' },
  ];
  const storesLeft = new Set(['s1', 's2']);
  const subscriptionsLeft = new Set(['s1', 's2']);
  const objectsLeft = new Set(documents.map((document) => document.objectKey));

  const stores: Pick<VectorStoreRepository, 'findById' | 'remove'> = {
    findById: (projectId, storeId) =>
      Promise.resolve(
        projectId === 'p1' && storesLeft.has(storeId) ? storeIn(projectId, storeId) : null,
      ),
    remove: (_projectId, storeId) => {
      trace.push(`store:${storeId}`);
      storesLeft.delete(storeId);
      return Promise.resolve();
    },
  };

  const subscriptions: Pick<StoreSubscriptionRepository, 'removeForStore'> = {
    removeForStore: (storeId) => {
      trace.push(`subscriptions:${storeId}`);
      subscriptionsLeft.delete(storeId);
      return Promise.resolve();
    },
  };

  const documentRepository: Pick<DocumentRepository, 'list' | 'removeForStore'> = {
    list: (input) => {
      const all = documents.filter((document) => document.storeId === input.storeId);
      const from = input.cursor === undefined ? 0 : Number(input.cursor);
      const items = all.slice(from, from + input.limit);
      const next = from + input.limit;
      trace.push(`documents:list:${String(from)}`);
      return Promise.resolve({
        items,
        nextCursor: next < all.length ? String(next) : null,
      });
    },
    removeForStore: (storeId) => {
      trace.push(`documents:${storeId}`);
      return Promise.resolve();
    },
  };

  const chunks: Pick<ChunkRepository, 'removeForStore'> = {
    removeForStore: (storeId) => {
      trace.push(`chunks:${storeId}`);
      return Promise.resolve();
    },
  };

  const index: Pick<VectorIndex, 'deleteStore'> = {
    deleteStore: (input) => {
      trace.push(`vectors:${input.storeId}`);
      for (let i = vectors.length - 1; i >= 0; i -= 1) {
        const point = vectors[i];
        if (point?.storeId === input.storeId && point.projectId === input.projectId) {
          vectors.splice(i, 1);
        }
      }
      return Promise.resolve();
    },
  };

  const objects: Pick<ObjectStore, 'remove'> = {
    remove: (input) => {
      if (options.objectStoreFails === true) return Promise.reject(new Error('storage said no'));
      trace.push(`object:${input.key}`);
      objectsLeft.delete(input.key);
      return Promise.resolve();
    },
  };

  const deleteStore = new DeleteStore(
    stores as VectorStoreRepository,
    subscriptions as StoreSubscriptionRepository,
    documentRepository as DocumentRepository,
    chunks as ChunkRepository,
    index as VectorIndex,
    objects as ObjectStore,
    BUCKET,
  );

  return { deleteStore, trace, vectors, storesLeft, subscriptionsLeft, objectsLeft };
}

describe('DeleteStore', () => {
  it('refuses a store belonging to another project as NOT FOUND, never as forbidden', async () => {
    const world = build();

    // A forbidden would confirm the store exists, which is the disclosure
    // `accessTo` prevents on the read path. Deleting must not be the leak.
    await expect(world.deleteStore.execute('p2', 's1')).rejects.toThrow(StoreNotFoundError);
    expect(world.storesLeft.has('s1')).toBe(true);
    expect(world.trace).toEqual([]);
  });

  it('refuses a store that does not exist, and touches nothing', async () => {
    const world = build();

    await expect(world.deleteStore.execute('p1', 'missing')).rejects.toThrow(StoreNotFoundError);
    expect(world.trace).toEqual([]);
  });

  it('drops the vectors before the chunks that describe them', async () => {
    const world = build();

    await world.deleteStore.execute('p1', 's1');

    // A chunk still searchable after its text is gone would surface an empty
    // citation, so the order is the assertion, not an implementation detail.
    expect(world.trace.indexOf('vectors:s1')).toBeLessThan(world.trace.indexOf('chunks:s1'));
  });

  it('leaves another store sharing the same collection untouched', async () => {
    const world = build();

    await world.deleteStore.execute('p1', 's1');

    expect(world.vectors).toEqual([{ storeId: 's2', projectId: 'p1' }]);
    expect(world.storesLeft.has('s2')).toBe(true);
    expect(world.subscriptionsLeft.has('s2')).toBe(true);
  });

  it('removes every subscriber consent before the store they point at', async () => {
    const world = build();

    await world.deleteStore.execute('p1', 's1');

    expect(world.subscriptionsLeft.has('s1')).toBe(false);
    expect(world.trace.indexOf('subscriptions:s1')).toBeLessThan(world.trace.indexOf('store:s1'));
  });

  it('removes the stored object of every document, across more than one page', async () => {
    const many = Array.from({ length: 250 }, (_, i) => documentIn('s1', `d${String(i)}`));
    const world = build({ documents: many });

    await world.deleteStore.execute('p1', 's1');

    expect(world.objectsLeft.size).toBe(0);
    // Paged rather than loaded whole: 250 documents at 100 a page is three
    // reads, and the third is what proves the loop advances to the end.
    expect(world.trace.filter((entry) => entry.startsWith('documents:list:'))).toEqual([
      'documents:list:0',
      'documents:list:100',
      'documents:list:200',
    ]);
  });

  it('still removes the store when object storage refuses to delete', async () => {
    const world = build({ objectStoreFails: true });

    await world.deleteStore.execute('p1', 's1');

    // Metadata pointing at an object nobody can reach is worse than an orphan
    // object: the store would keep listing documents that cannot be read.
    expect(world.storesLeft.has('s1')).toBe(false);
    expect(world.trace).toContain('documents:s1');
  });
});

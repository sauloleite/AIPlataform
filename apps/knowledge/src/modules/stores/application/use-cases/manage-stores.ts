import { Inject, Injectable } from '@nestjs/common';

import { StoreNotFoundError } from '../../domain/errors/index.js';
import type { DocumentView, StoreView } from '../dto.js';
import {
  CHUNK_REPOSITORY,
  DOCUMENT_REPOSITORY,
  KNOWLEDGE_BUCKET,
  OBJECT_STORE,
  STORE_REPOSITORY,
  STORE_SUBSCRIPTION_REPOSITORY,
  VECTOR_INDEX,
  type ChunkRepository,
  type DocumentRepository,
  type ObjectStore,
  type StoreSubscriptionRepository,
  type VectorIndex,
  type VectorStoreRepository,
} from '../ports.js';
import { documentView, storeView } from '../views.js';
import { ResolveReadableStore } from './share-store.js';

@Injectable()
export class ListStores {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
  ) {}

  async execute(input: {
    projectId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: StoreView[]; nextCursor: string | null }> {
    const page = await this.stores.list(input);
    const counts = await this.documents.countByStore(
      input.projectId,
      page.items.map((store) => store.id),
    );

    const owned: StoreView[] = page.items.map((store) => ({
      ...storeView(store),
      access: 'owner' as const,
      documentCount: counts[store.id] ?? 0,
    }));

    // Subscribed stores are appended rather than paged, and only on the first
    // page: they belong to another project, so they do not share this one's
    // cursor ordering, and interleaving them would make the cursor lie.
    const shared = input.cursor === undefined ? await this.subscribed(input.projectId) : [];

    return { items: [...owned, ...shared], nextCursor: page.nextCursor };
  }

  private async subscribed(projectId: string): Promise<StoreView[]> {
    const ids = await this.subscriptions.listForProject(projectId);
    const views: StoreView[] = [];

    for (const id of ids) {
      const store = await this.stores.findByIdAcrossProjects(id);
      // Withdrawn or deleted since the subscription was made. Skipped rather
      // than shown as broken: the owner revoked it, and that is the answer.
      if (store?.isPublic !== true) continue;

      const counts = await this.documents.countByStore(store.projectId, [store.id]);
      views.push({
        ...storeView(store),
        access: 'shared',
        documentCount: counts[store.id] ?? 0,
      });
    }

    return views;
  }
}

@Injectable()
export class GetStore {
  constructor(
    @Inject(ResolveReadableStore) private readonly resolve: ResolveReadableStore,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
  ) {}

  async execute(projectId: string, storeId: string): Promise<StoreView> {
    const { store, access } = await this.resolve.execute({ projectId, storeId });

    // Counted in the OWNER's project: a subscriber asking for its own would
    // read zero and see a store that looks empty rather than shared.
    const counts = await this.documents.countByStore(store.projectId, [storeId]);
    return { ...storeView(store), access, documentCount: counts[storeId] ?? 0 };
  }
}

@Injectable()
export class ListDocuments {
  constructor(
    @Inject(ResolveReadableStore) private readonly resolve: ResolveReadableStore,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
  ) {}

  async execute(input: {
    projectId: string;
    storeId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: DocumentView[]; nextCursor: string | null }> {
    const { store, access } = await this.resolve.execute({
      projectId: input.projectId,
      storeId: input.storeId,
    });

    // The owner's documents, listed under the owner's project.
    const page = await this.documents.list({ ...input, projectId: store.projectId });

    // A subscriber sees exactly what it could search: the public ones. Listing
    // a restricted title is already a disclosure, even without its text.
    const items = access === 'shared' ? page.items.filter((item) => item.acl.isPublic) : page.items;

    return { items: items.map(documentView), nextCursor: page.nextCursor };
  }
}

/**
 * Removes a document, its chunks and its vectors.
 *
 * Also the erasure hook for a data subject request (LGPD): what was indexed
 * from the document goes with it.
 */
@Injectable()
export class DeleteDocument {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(CHUNK_REPOSITORY) private readonly chunks: ChunkRepository,
    @Inject(VECTOR_INDEX) private readonly index: VectorIndex,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(KNOWLEDGE_BUCKET) private readonly bucket: string,
  ) {}

  async execute(projectId: string, storeId: string, documentId: string): Promise<void> {
    const store = await this.stores.findById(projectId, storeId);
    if (store === null) throw new StoreNotFoundError(storeId, projectId);

    const document = await this.documents.findById(projectId, documentId);
    if (document === null) return;

    // Vectors first: a chunk still searchable after its text is gone would
    // surface an empty citation.
    await this.index.deleteDocument({
      collection: store.collectionName,
      projectId,
      documentId,
    });
    await this.chunks.removeForDocument(documentId);
    await this.objects.remove({ bucket: this.bucket, key: document.objectKey }).catch(() => {
      // The object is already unreachable from the platform; a storage that
      // refuses the delete must not leave the metadata behind.
    });
    await this.documents.remove(documentId);
  }
}

/**
 * Removes a store, everything indexed from it, and everyone's access to it.
 *
 * Only the OWNER may delete, and a non-owner is refused with StoreNotFoundError
 * rather than a forbidden: `findById` is scoped by project, and telling a
 * stranger that a store exists is already a disclosure (the rule `accessTo`
 * applies on the read path, applied here on the write path).
 *
 * The order is the order of consequences. Vectors go before the chunks that
 * describe them, so nothing is ever searchable without its text. Subscriptions
 * go before the store, so no project is left holding a reference to something
 * that has stopped existing. The store record goes last: while it is there, a
 * failure halfway is resumable by asking again, and every step is idempotent.
 */
@Injectable()
export class DeleteStore {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(CHUNK_REPOSITORY) private readonly chunks: ChunkRepository,
    @Inject(VECTOR_INDEX) private readonly index: VectorIndex,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(KNOWLEDGE_BUCKET) private readonly bucket: string,
  ) {}

  async execute(projectId: string, storeId: string): Promise<void> {
    const store = await this.stores.findById(projectId, storeId);
    if (store === null) throw new StoreNotFoundError(storeId, projectId);

    await this.index.deleteStore({
      collection: store.collectionName,
      projectId,
      storeId,
    });
    await this.chunks.removeForStore(storeId);
    await this.removeObjects(projectId, storeId);
    await this.documents.removeForStore(storeId);
    await this.subscriptions.removeForStore(storeId);
    await this.stores.remove(projectId, storeId);
  }

  /**
   * Paged rather than loaded at once: a store holding fifty thousand documents
   * would otherwise pull every one of them into memory to read one field.
   */
  private async removeObjects(projectId: string, storeId: string): Promise<void> {
    let cursor: string | undefined;

    do {
      const page = await this.documents.list({
        projectId,
        storeId,
        limit: OBJECT_DELETE_PAGE,
        ...(cursor !== undefined && { cursor }),
      });

      for (const document of page.items) {
        await this.objects.remove({ bucket: this.bucket, key: document.objectKey }).catch(() => {
          // Same reasoning as DeleteDocument: object storage that refuses the
          // delete must not leave the metadata behind pointing at it.
        });
      }

      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }
}

/** Documents per page while deleting. Bounded work, not a bounded result. */
const OBJECT_DELETE_PAGE = 100;

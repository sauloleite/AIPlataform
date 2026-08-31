import { Inject, Injectable, Logger } from '@nestjs/common';

import type { StoreVisibility, VectorStore } from '../../domain/entities/vector-store.js';
import {
  EmbeddingDimensionMismatchError,
  InvalidStoreError,
  StoreNotFoundError,
} from '../../domain/errors/index.js';
import { accessTo, type StoreAccess } from '../../domain/services/store-access.js';
import type { StoreView } from '../dto.js';
import {
  CLOCK,
  EMBEDDING_CLIENT,
  STORE_REPOSITORY,
  STORE_SUBSCRIPTION_REPOSITORY,
  type Clock,
  type EmbeddingClient,
  type StoreSubscriptionRepository,
  type VectorStoreRepository,
} from '../ports.js';
import { storeView } from '../views.js';

/**
 * The owner's half: offering the store, or withdrawing the offer (ADR-023).
 *
 * Reads with the tenant in the query, so a project that does not own the store
 * cannot publish it -- it gets the same not-found a stranger gets.
 */
@Injectable()
export class ChangeStoreVisibility {
  private readonly logger = new Logger(ChangeStoreVisibility.name);

  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    storeId: string;
    visibility: StoreVisibility;
  }): Promise<StoreView> {
    const store = await this.stores.findById(input.projectId, input.storeId);
    if (store === null) throw new StoreNotFoundError(input.storeId, input.projectId);

    store.changeVisibility(input.visibility, this.clock.now());
    await this.stores.save(store);

    // Withdrawing revokes: leaving the subscriptions in place would mean
    // republishing later silently restores everyone's access, which is not
    // what withdrawing meant.
    if (input.visibility === 'private') {
      await this.subscriptions.removeForStore(store.id);
      this.logger.log(`store ${store.id} withdrawn; subscriptions dropped`);
    }

    return storeView(store);
  }
}

/**
 * The consumer's half: accepting a published store.
 *
 * It probes the embedding alias with the SUBSCRIBER's own token before
 * accepting, because an alias is not the same thing in two projects. It
 * resolves through the router under the caller's data-classification policy,
 * so a project restricted to local models can resolve `embedding-default` to a
 * different provider -- or, as happened the first time this ran, to a provider
 * with no reachable deployment at all.
 *
 * Embedding the query under the OWNER's project instead would make it work and
 * would be wrong: the question is the subscriber's data, and routing it under
 * somebody else's policy is exactly the residency rule they declared. So an
 * incompatible pair is refused here, once, with a reason -- rather than at
 * every search, as a 503 nobody can act on.
 */
@Injectable()
export class SubscribeToStore {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
    @Inject(EMBEDDING_CLIENT) private readonly embeddings: EmbeddingClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    storeId: string;
    principalId: string;
    accessToken: string;
  }): Promise<StoreView> {
    const store = await this.stores.findByIdAcrossProjects(input.storeId);
    if (store === null) throw new StoreNotFoundError(input.storeId, input.projectId);

    if (store.projectId === input.projectId) {
      throw new InvalidStoreError('A project already reaches its own stores');
    }
    // Not-found rather than forbidden: an unpublished store must not be
    // discoverable by trying to subscribe to it.
    if (!store.isPublic) throw new StoreNotFoundError(input.storeId, input.projectId);

    await this.assertReadable(store.embeddingAlias, store.dimensions, input);

    await this.subscriptions.subscribe({
      projectId: input.projectId,
      storeId: store.id,
      principalId: input.principalId,
      now: this.clock.now(),
    });

    return { ...storeView(store), access: 'shared', subscribed: true };
  }

  private async assertReadable(
    alias: string,
    dimensions: number,
    input: { projectId: string; accessToken: string },
  ): Promise<void> {
    const probe = await this.embeddings
      .embed({
        projectId: input.projectId,
        accessToken: input.accessToken,
        alias,
        texts: ['dimension probe'],
      })
      .catch(() => null);

    if (probe === null) {
      throw new InvalidStoreError(
        `This project cannot reach the embedding alias "${alias}" that the store was built ` +
          `with. Its data classification routes that alias somewhere else, so the store ` +
          `cannot be searched from here.`,
      );
    }

    const width = probe.vectors[0]?.length ?? 0;
    if (width !== dimensions) {
      // Same alias, different provider, different width. Subscribing would
      // succeed and every search would then fail the read-path guard.
      throw new EmbeddingDimensionMismatchError(dimensions, width);
    }
  }
}

@Injectable()
export class UnsubscribeFromStore {
  constructor(
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
  ) {}

  async execute(input: { projectId: string; storeId: string }): Promise<void> {
    // No existence check: unsubscribing from something already gone is the
    // state the caller asked for.
    await this.subscriptions.unsubscribe(input);
  }
}

/**
 * The catalogue: published stores this project could accept.
 *
 * It reports what is already subscribed rather than hiding it, so the screen
 * can show "added" instead of quietly dropping a row the user just accepted.
 */
@Injectable()
export class ListStoreCatalogue {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
  ) {}

  async execute(input: {
    projectId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: StoreView[]; nextCursor: string | null }> {
    const page = await this.stores.listPublic({
      excludingProjectId: input.projectId,
      limit: input.limit,
      ...(input.cursor !== undefined && { cursor: input.cursor }),
    });
    const subscribed = new Set(await this.subscriptions.listForProject(input.projectId));

    return {
      items: page.items.map((store) => ({
        ...storeView(store),
        subscribed: subscribed.has(store.id),
      })),
      nextCursor: page.nextCursor,
    };
  }
}

/**
 * Resolves a store the caller may read, owned or subscribed.
 *
 * Shared so that every read path asks the same question once, instead of each
 * one growing its own version of "is this mine, or did I subscribe".
 */
@Injectable()
export class ResolveReadableStore {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
  ) {}

  async execute(input: {
    projectId: string;
    storeId: string;
  }): Promise<{ store: VectorStore; access: StoreAccess }> {
    const store = await this.stores.findByIdAcrossProjects(input.storeId);
    if (store === null) throw new StoreNotFoundError(input.storeId, input.projectId);

    const owns = store.projectId === input.projectId;
    const subscribed = owns
      ? false
      : await this.subscriptions.isSubscribed({
          projectId: input.projectId,
          storeId: store.id,
        });

    const access = accessTo({
      store: { id: store.id, projectId: store.projectId, isPublic: store.isPublic },
      requestingProjectId: input.projectId,
      subscribed,
    });

    return { store, access };
  }
}

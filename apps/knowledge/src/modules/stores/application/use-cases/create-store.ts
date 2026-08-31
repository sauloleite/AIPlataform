import { Inject, Injectable } from '@nestjs/common';
import { VectorStore } from '../../domain/entities/vector-store.js';
import { InvalidStoreError } from '../../domain/errors/index.js';
import { ChunkingStrategy } from '../../domain/value-objects/chunking-strategy.js';
import type { CreateStoreCommand, StoreView } from '../dto.js';
import {
  STORE_REPOSITORY,
  VECTOR_INDEX,
  EMBEDDING_CLIENT,
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type EmbeddingClient,
  type IdGenerator,
  type VectorIndex,
  type VectorStoreRepository,
} from '../ports.js';
import { storeView } from '../views.js';

/**
 * Creates a store and the collection behind it.
 *
 * The embedding width is discovered by embedding one short probe: the alias
 * says which model, and only the model knows how wide its vectors are. Pinning
 * it here is what lets ingestion later refuse a vector of the wrong width
 * instead of corrupting the index.
 */
@Injectable()
export class CreateStore {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(VECTOR_INDEX) private readonly index: VectorIndex,
    @Inject(EMBEDDING_CLIENT) private readonly embeddings: EmbeddingClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateStoreCommand): Promise<StoreView> {
    const existing = await this.stores.findBySlug(command.projectId, command.slug);
    if (existing !== null) {
      throw new InvalidStoreError(`A store called "${command.slug}" already exists`);
    }

    const chunking = ChunkingStrategy.of(command.chunking);

    const probe = await this.embeddings.embed({
      projectId: command.projectId,
      accessToken: command.accessToken,
      alias: command.embeddingAlias,
      texts: ['dimension probe'],
    });
    const dimensions = probe.vectors[0]?.length ?? 0;
    if (dimensions < 1) {
      throw new InvalidStoreError(
        `The alias "${command.embeddingAlias}" did not return an embedding`,
      );
    }

    const store = VectorStore.create({
      id: this.ids.next(),
      projectId: command.projectId,
      slug: command.slug,
      name: command.name,
      ...(command.description !== undefined && { description: command.description }),
      embeddingAlias: command.embeddingAlias,
      embeddingModel: probe.model,
      dimensions,
      chunking,
      now: this.clock.now(),
    });

    // The collection before the store: a store pointing at a collection that
    // does not exist would fail on its first upload instead of here.
    await this.index.ensureCollection({
      name: store.collectionName,
      dimensions: store.dimensions,
      distance: store.distance,
    });
    await this.stores.save(store);

    return storeView(store);
  }
}

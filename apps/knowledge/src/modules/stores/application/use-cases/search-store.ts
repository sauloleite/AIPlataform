import { Inject, Injectable, Logger } from '@nestjs/common';

import { EmbeddingDimensionMismatchError, StoreNotFoundError } from '../../domain/errors/index.js';
import { fuse, type FusedChunk } from '../../domain/services/fusion.js';
import { accessTo } from '../../domain/services/store-access.js';
import { trimmingSpecFor, type TrimmingSpec } from '../../domain/services/security-trimming.js';
import type { SearchCommand, SearchHitView } from '../dto.js';
import {
  STORE_REPOSITORY,
  STORE_SUBSCRIPTION_REPOSITORY,
  DOCUMENT_REPOSITORY,
  CHUNK_REPOSITORY,
  EMBEDDING_CLIENT,
  VECTOR_INDEX,
  type ChunkRepository,
  type DocumentRepository,
  type EmbeddingClient,
  type StoreSubscriptionRepository,
  type VectorIndex,
  type VectorStoreRepository,
} from '../ports.js';

/**
 * How many candidates each ranking contributes before fusion.
 *
 * Fusing the top `topK` of each would defeat the point: the chunk worth
 * finding is the one a nearest-neighbour search ranks twentieth and a lexical
 * search ranks first, and at a depth of five it is in neither list to be
 * fused. Depth is where hybrid search earns its keep.
 */
const CANDIDATE_MULTIPLIER = 4;
const CANDIDATE_FLOOR = 20;

export function candidateDepth(topK: number): number {
  return Math.max(topK * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR);
}

/**
 * Searches a store, trimmed to what the caller may see.
 *
 * The trimming spec is built once and handed to BOTH rankings, each of which
 * applies it inside its own query (ADR-006, ADR-022). Nothing here filters a
 * result list: a chunk the caller may not read was never a candidate.
 */
@Injectable()
export class SearchStore {
  private readonly logger = new Logger(SearchStore.name);

  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(STORE_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: StoreSubscriptionRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(CHUNK_REPOSITORY) private readonly chunks: ChunkRepository,
    @Inject(EMBEDDING_CLIENT) private readonly embeddings: EmbeddingClient,
    @Inject(VECTOR_INDEX) private readonly index: VectorIndex,
  ) {}

  async execute(command: SearchCommand): Promise<SearchHitView[]> {
    const store = await this.stores.findByIdAcrossProjects(command.storeId);
    if (store === null) throw new StoreNotFoundError(command.storeId, command.projectId);

    // Own it, or have accepted it. `accepted` is not even asked for the owner:
    // a project cannot subscribe to itself, and asking would invite a wrong
    // answer to grant an access the ownership check already settled.
    const owns = store.projectId === command.projectId;
    const subscribed = owns
      ? false
      : await this.subscriptions.isSubscribed({
          projectId: command.projectId,
          storeId: store.id,
        });

    // Throws StoreNotFoundError when neither holds: a project that may not
    // read a store must not learn that it exists.
    const access = accessTo({
      store: { id: store.id, projectId: store.projectId, isPublic: store.isPublic },
      requestingProjectId: command.projectId,
      subscribed,
    });

    const trimming = trimmingSpecFor({
      requestingProjectId: command.projectId,
      store: { id: store.id, projectId: store.projectId },
      access,
      principalId: command.principalId,
      principalGroups: command.principalGroups,
    });

    const embedded = await this.embeddings.embed({
      projectId: command.projectId,
      accessToken: command.accessToken,
      alias: store.embeddingAlias,
      texts: [command.query],
    });
    const vector = embedded.vectors[0];
    if (vector === undefined) return [];

    // The same guard ingestion has, on the read path. An alias can resolve to a
    // different provider than the one the store was built with -- a key
    // expires, a deployment falls over -- and a query vector of the wrong width
    // would otherwise reach the index and come back as an opaque 500.
    if (vector.length !== store.dimensions) {
      throw new EmbeddingDimensionMismatchError(store.dimensions, vector.length);
    }

    const matches =
      (command.mode ?? 'hybrid') === 'vector'
        ? await this.vectorOnly(command, trimming, vector, store.collectionName)
        : await this.hybrid(command, trimming, vector, store.collectionName);

    if (matches.length === 0) return [];
    return this.hydrate(command, trimming, matches);
  }

  /** The pure nearest-neighbour search, unchanged: cosine in, cosine out. */
  private async vectorOnly(
    command: SearchCommand,
    trimming: TrimmingSpec,
    vector: readonly number[],
    collection: string,
  ): Promise<FusedChunk[]> {
    const found = await this.index.search({
      collection,
      vector,
      limit: command.topK,
      trimming,
      ...(command.minScore !== undefined && { minScore: command.minScore }),
    });

    return found.map((match) => ({
      documentId: match.documentId,
      chunkIndex: match.chunkIndex,
      score: match.score,
      retrieval: 'vector' as const,
      vectorScore: match.score,
    }));
  }

  private async hybrid(
    command: SearchCommand,
    trimming: TrimmingSpec,
    vector: readonly number[],
    collection: string,
  ): Promise<FusedChunk[]> {
    const depth = candidateDepth(command.topK);

    // Two stores, two round trips, no reason to pay for them in series.
    const [vectorMatches, textMatches] = await Promise.all([
      this.index.search({
        collection,
        vector,
        limit: depth,
        trimming,
        // A cosine floor bounds the vector ranking only. The lexical one has no
        // comparable scale, and fusion reads positions rather than scores.
        ...(command.minScore !== undefined && { minScore: command.minScore }),
      }),
      this.chunks.searchText({ trimming, query: command.query, limit: depth }),
    ]);

    return fuse({
      vector: vectorMatches.map((match) => ({
        documentId: match.documentId,
        chunkIndex: match.chunkIndex,
        score: match.score,
      })),
      text: textMatches,
      limit: command.topK,
    });
  }

  private async hydrate(
    command: SearchCommand,
    trimming: TrimmingSpec,
    matches: FusedChunk[],
  ): Promise<SearchHitView[]> {
    const hits: SearchHitView[] = [];

    for (const match of matches) {
      // The OWNER's project. Reading with the caller's would find nothing on a
      // shared store, which would look like an empty index rather than a bug.
      const document = await this.documents.findById(trimming.projectId, match.documentId);
      if (document === null) continue;

      // Defence in depth. Both rankings already filtered, so if this disagrees
      // one of them is out of step -- which is a leak, and it should be loud.
      // The ranking is named because it says which translation to go and read.
      //
      // Across a project boundary the question is only "is it public": the
      // caller's groups are roles in THEIR project and say nothing about a
      // document restricted inside the owner's.
      const allowed = trimming.crossProject
        ? document.acl.isPublic
        : document.acl.allows(command.principalId, command.principalGroups);
      if (!allowed) {
        this.logger.error(
          `the ${match.retrieval} ranking returned a chunk the ACL forbids: ` +
            `document ${document.id}, principal ${command.principalId}`,
        );
        continue;
      }

      const stored = await this.chunks.findMany({
        projectId: trimming.projectId,
        documentId: document.id,
        version: document.version,
        indexes: [match.chunkIndex],
      });
      const text = stored[0]?.text;
      if (text === undefined) continue;

      hits.push({
        documentId: document.id,
        documentTitle: document.title,
        chunkIndex: match.chunkIndex,
        score: match.score,
        retrieval: match.retrieval,
        ...(match.vectorScore !== undefined && { vectorScore: match.vectorScore }),
        text,
      });
    }

    return hits;
  }
}

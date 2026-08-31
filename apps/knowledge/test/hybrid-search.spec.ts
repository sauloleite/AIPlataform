import { describe, expect, it } from 'vitest';

import {
  SearchStore,
  candidateDepth,
} from '../src/modules/stores/application/use-cases/search-store.js';
import { VectorStore } from '../src/modules/stores/domain/entities/vector-store.js';
import { Document } from '../src/modules/stores/domain/entities/document.js';
import { ChunkingStrategy } from '../src/modules/stores/domain/value-objects/chunking-strategy.js';
import { DocumentAcl } from '../src/modules/stores/domain/value-objects/document-acl.js';
import type { TrimmingSpec } from '../src/modules/stores/domain/services/security-trimming.js';
import type {
  ChunkRepository,
  DocumentRepository,
  EmbeddingClient,
  StoreSubscriptionRepository,
  TextMatch,
  VectorIndex,
  VectorMatch,
  VectorStoreRepository,
} from '../src/modules/stores/application/ports.js';

const NOW = new Date('2026-08-29T00:00:00Z');
const WIDTH = 4;

const store = VectorStore.create({
  id: 's1',
  projectId: 'p1',
  slug: 'runbook',
  name: 'Runbook',
  embeddingAlias: 'embedding-default',
  embeddingModel: 'fake',
  dimensions: WIDTH,
  chunking: ChunkingStrategy.default(),
  now: NOW,
});

/**
 * One corpus, and both fakes read it through the SAME trimming spec.
 *
 * A fake that ignored the spec would make every trimming test pass while the
 * real adapters leaked, so these two apply it the way Qdrant and MongoDB do.
 */
interface Row {
  documentId: string;
  chunkIndex: number;
  projectId: string;
  storeId: string;
  text: string;
  acl: DocumentAcl;
  /** Where the vector ranking would place it; lower is nearer. */
  distance: number;
}

const PUBLIC = DocumentAcl.publicToProject();
const FINANCE_ONLY = DocumentAcl.of({ isPublic: false, groups: ['finance'] });

const CORPUS: Row[] = [
  {
    documentId: 'd1',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'restarting the router drains traffic',
    acl: PUBLIC,
    distance: 1,
  },
  {
    documentId: 'd2',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'audit records are kept for 365 days',
    acl: PUBLIC,
    distance: 9,
  },
  {
    documentId: 'd3',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'meals reimbursed up to BRL 120',
    acl: PUBLIC,
    distance: 2,
  },
  // Same project, another store: must never appear for a search on s1.
  {
    documentId: 'd4',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's2',
    text: 'audit records 365 elsewhere',
    acl: PUBLIC,
    distance: 0,
  },
  // Another tenant entirely, with identical wording.
  {
    documentId: 'd5',
    chunkIndex: 0,
    projectId: 'p2',
    storeId: 's1',
    text: 'audit records are kept for 365 days',
    acl: PUBLIC,
    distance: 0,
  },
  // Restricted to a group the caller is not in.
  {
    documentId: 'd6',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'audit 365 salary bands',
    acl: FINANCE_ONLY,
    distance: 0,
  },
  // Filler, and not incidental: without enough visible neighbours a top-3
  // vector search returns the whole store, and the test below would be
  // asserting about the corpus rather than about the ranking.
  {
    documentId: 'd7',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'rotating a provider key',
    acl: PUBLIC,
    distance: 3,
  },
  {
    documentId: 'd8',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'production credentials policy',
    acl: PUBLIC,
    distance: 4,
  },
  {
    documentId: 'd9',
    chunkIndex: 0,
    projectId: 'p1',
    storeId: 's1',
    text: 'circuit breaker reopens',
    acl: PUBLIC,
    distance: 5,
  },
];

/**
 * What an adapter is supposed to admit, spelled out the way both translations
 * spell it: the owning project, the store, and one of the ACL alternatives the
 * spec resolved. A fake that called `acl.allows` directly would keep passing
 * across a project boundary, where the real filters admit only public.
 */
function visibleTo(spec: TrimmingSpec): Row[] {
  return CORPUS.filter(
    (row) =>
      row.projectId === spec.projectId &&
      row.storeId === spec.storeId &&
      (row.acl.isPublic ||
        row.acl.groups.some((group) => spec.aclGroups.includes(group)) ||
        row.acl.principals.some((principal) => spec.aclPrincipals.includes(principal))),
  );
}

/** Published, so a subscriber has something to have accepted. */
const publishedStore = VectorStore.rehydrate({ ...store.snapshot(), visibility: 'public' });

function storesReturning(found: VectorStore): VectorStoreRepository {
  return {
    findById: () => Promise.resolve(found),
    findByIdAcrossProjects: () => Promise.resolve(found),
  } as unknown as VectorStoreRepository;
}

function subscriptionsThatAnswer(subscribed: boolean): StoreSubscriptionRepository {
  return {
    isSubscribed: () => Promise.resolve(subscribed),
  } as unknown as StoreSubscriptionRepository;
}

const documents = {
  findById: (_projectId: string, documentId: string) => {
    const row = CORPUS.find((entry) => entry.documentId === documentId);
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve(
      Document.rehydrate({
        id: row.documentId,
        projectId: row.projectId,
        storeId: row.storeId,
        title: row.documentId.toUpperCase(),
        objectKey: `k/${row.documentId}`,
        mimeType: 'text/markdown',
        sizeBytes: 10,
        acl: row.acl,
        ownerPrincipalId: 'user-1',
        status: 'ingested',
        version: 1,
        chunkCount: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  },
} as unknown as DocumentRepository;

const embeddings: EmbeddingClient = {
  maxBatchSize: 16,
  embed: () =>
    Promise.resolve({ vectors: [Array.from({ length: WIDTH }, () => 0.1)], model: 'fake' }),
};

function fakes(): {
  index: VectorIndex;
  chunks: ChunkRepository;
  seen: { vectorLimit: number; textLimit: number; textCalls: number };
} {
  const seen = { vectorLimit: 0, textLimit: 0, textCalls: 0 };

  const index = {
    search: (input: { limit: number; trimming: TrimmingSpec }): Promise<VectorMatch[]> => {
      seen.vectorLimit = input.limit;
      const matches = visibleTo(input.trimming)
        .slice()
        .sort((left, right) => left.distance - right.distance)
        .slice(0, input.limit)
        .map((row) => ({
          documentId: row.documentId,
          chunkIndex: row.chunkIndex,
          score: 1 - row.distance / 100,
        }));
      return Promise.resolve(matches);
    },
  } as unknown as VectorIndex;

  const chunks = {
    searchText: (input: {
      trimming: TrimmingSpec;
      query: string;
      limit: number;
    }): Promise<TextMatch[]> => {
      seen.textLimit = input.limit;
      seen.textCalls += 1;
      const terms = input.query
        .toLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length > 0);
      const matches = visibleTo(input.trimming)
        .filter((row) => terms.some((term) => row.text.toLowerCase().includes(term)))
        .slice(0, input.limit)
        .map((row) => ({ documentId: row.documentId, chunkIndex: row.chunkIndex, score: 1 }));
      return Promise.resolve(matches);
    },
    findMany: (input: { documentId: string }) => {
      const row = CORPUS.find((entry) => entry.documentId === input.documentId);
      return Promise.resolve(
        row === undefined
          ? []
          : [{ documentId: row.documentId, version: 1, index: 0, text: row.text }],
      );
    },
  } as unknown as ChunkRepository;

  return { index, chunks, seen };
}

function search(
  overrides: Partial<Parameters<SearchStore['execute']>[0]> = {},
  shared?: { published?: boolean; subscribed: boolean },
) {
  const { index, chunks, seen } = fakes();
  const useCase = new SearchStore(
    storesReturning(
      shared?.published === false ? store : shared === undefined ? store : publishedStore,
    ),
    subscriptionsThatAnswer(shared?.subscribed ?? false),
    documents,
    chunks,
    embeddings,
    index,
  );

  return {
    seen,
    run: () =>
      useCase.execute({
        projectId: 'p1',
        storeId: 's1',
        principalId: 'user-1',
        principalGroups: [],
        accessToken: 'token',
        query: '365',
        topK: 3,
        ...overrides,
      }),
  };
}

describe('hybrid search', () => {
  it('finds by exact token what the vector ranking buries', () => {
    // d2 is ninth-nearest and would fall outside a top-3 vector search. The
    // lexical ranking puts it first, and fusion has to carry it through.
    const { run } = search();

    return run().then((hits) => {
      expect(hits.map((hit) => hit.documentId)).toContain('d2');
      expect(hits.find((hit) => hit.documentId === 'd2')?.retrieval).toBe('both');
    });
  });

  it('asks each ranking for more candidates than it will return', () => {
    const { seen, run } = search({ topK: 3 });

    return run().then(() => {
      expect(seen.vectorLimit).toBe(candidateDepth(3));
      expect(seen.textLimit).toBe(candidateDepth(3));
      expect(seen.vectorLimit).toBeGreaterThan(3);
    });
  });

  it('never returns another store, another tenant, or a document the ACL forbids', () => {
    // d4 (other store), d5 (other tenant) and d6 (finance only) are all nearer
    // than the answer and all say "365". Every one of them is a leak.
    const { run } = search({ topK: 10 });

    return run().then((hits) => {
      const found = hits.map((hit) => hit.documentId);
      expect(found).not.toContain('d4');
      expect(found).not.toContain('d5');
      expect(found).not.toContain('d6');
    });
  });

  it('lets a caller in the group see what is restricted to it', () => {
    // The mirror of the test above: trimming has to admit as well as refuse,
    // or an empty result would look like a passing security test.
    const { run } = search({ principalGroups: ['finance'], topK: 10 });

    return run().then((hits) => {
      expect(hits.map((hit) => hit.documentId)).toContain('d6');
    });
  });

  it('honours top_k after fusion, not before', () => {
    const { run } = search({ topK: 2 });

    return run().then((hits) => {
      expect(hits).toHaveLength(2);
    });
  });
});

describe('vector mode', () => {
  it('does not consult the lexical ranking at all', () => {
    const { seen, run } = search({ mode: 'vector' });

    return run().then(() => {
      expect(seen.textCalls).toBe(0);
    });
  });

  it('asks for exactly top_k and reports the cosine as the score', () => {
    const { seen, run } = search({ mode: 'vector', topK: 3 });

    return run().then((hits) => {
      expect(seen.vectorLimit).toBe(3);
      expect(hits[0]?.retrieval).toBe('vector');
      expect(hits[0]?.score).toBe(hits[0]?.vectorScore);
    });
  });

  it('still misses the exact token, which is why hybrid is the default', () => {
    // Not a wish -- the measured behaviour this work exists to change. If this
    // ever passes, the premise is gone and so is the reason for the fusion.
    const { run } = search({ mode: 'vector', topK: 3 });

    return run().then((hits) => {
      expect(hits.map((hit) => hit.documentId)).not.toContain('d2');
    });
  });
});

/**
 * A subscriber reads the owner's store. Everything about the trimming changes
 * shape here, so it is exercised end to end rather than only at the spec.
 */
describe('a subscribed project searching a shared store', () => {
  const asSubscriber = (overrides = {}) =>
    search(
      { projectId: 'p2', principalGroups: ['finance'], topK: 10, ...overrides },
      {
        subscribed: true,
      },
    );

  it("reads the owner's public chunks", () => {
    return asSubscriber()
      .run()
      .then((hits) => {
        expect(hits.map((hit) => hit.documentId)).toContain('d2');
      });
  });

  it('never sees a document restricted inside the owning project', () => {
    // The caller holds `finance` in THEIR project. d6 is restricted to
    // `finance` in the owner's. Same word, different grant.
    return asSubscriber()
      .run()
      .then((hits) => {
        expect(hits.map((hit) => hit.documentId)).not.toContain('d6');
      });
  });

  it('still cannot reach another store, even a public one', () => {
    return asSubscriber()
      .run()
      .then((hits) => {
        expect(hits.map((hit) => hit.documentId)).not.toContain('d4');
      });
  });

  it('refuses outright when the project never subscribed', () => {
    // Published is not accepted. Without the subscription the store is not
    // merely empty for this project -- it does not exist.
    return expect(
      search({ projectId: 'p2', topK: 10 }, { subscribed: false }).run(),
    ).rejects.toThrow();
  });
});

describe('a store that was never published', () => {
  it('is not reachable even by a project that claims to have subscribed', () => {
    // Both consents are required, and the owner's is the one recorded on the
    // store. A stray subscription row must not be enough on its own.
    return expect(
      search({ projectId: 'p2', topK: 10 }, { published: false, subscribed: true }).run(),
    ).rejects.toThrow();
  });
});

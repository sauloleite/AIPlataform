import { describe, expect, it } from 'vitest';

import { summarise } from '../src/modules/knowledge/application/use-cases/inspect-store';
import type {
  DocumentSummary,
  IngestionStatus,
  StoreSummary,
} from '../src/modules/knowledge/application/ports';

const store: StoreSummary = {
  id: 's1',
  ownerProjectId: 'p1',
  visibility: 'private',
  access: 'owner',
  slug: 'handbook',
  name: 'Handbook',
  embeddingAlias: 'embedding-default',
  embeddingModel: 'nomic-embed-text',
  dimensions: 768,
  chunking: { kind: 'markdown-heading', maxTokens: 512, overlapTokens: 64 },
  documentCount: 0,
  updatedAt: '2026-08-27T00:00:00Z',
};

const document = (status: IngestionStatus): DocumentSummary => ({
  id: `d-${status}`,
  storeId: 's1',
  title: status,
  mimeType: 'text/markdown',
  sizeBytes: 10,
  status,
  errorCode: status === 'failed' ? 'unsupported_media_type' : null,
  chunkCount: 0,
  createdAt: '2026-08-27T00:00:00Z',
  ingestedAt: null,
});

describe('summarise', () => {
  it('counts everything still moving through the pipeline', () => {
    const detail = summarise(store, [
      document('pending'),
      document('parsing'),
      document('embedding'),
      document('ingested'),
    ]);
    expect(detail.ingestingCount).toBe(3);
  });

  // Ingested and failed are the two resting states; neither is "in progress",
  // or the console would spin forever on a document that already gave up.
  it('treats failed as finished, not as in progress', () => {
    const detail = summarise(store, [document('failed'), document('ingested')]);
    expect(detail.ingestingCount).toBe(0);
    expect(detail.failedCount).toBe(1);
  });

  it('reports an empty store as idle', () => {
    const detail = summarise(store, []);
    expect(detail.ingestingCount).toBe(0);
    expect(detail.failedCount).toBe(0);
    expect(detail.documents).toEqual([]);
  });
});

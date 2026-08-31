import { describe, expect, it } from 'vitest';

import { toDetail } from '../src/modules/registry/application/use-cases/inspect-agent';
import { toCard } from '../src/modules/registry/application/use-cases/list-agents';
import type {
  AssetDetail,
  AssetSummary,
  AssetVersionSummary,
} from '../src/modules/registry/application/ports';

const asset = (o: Partial<AssetSummary> = {}): AssetSummary => ({
  id: 'a1',
  kind: 'agent',
  slug: 'support',
  name: 'Support',
  publishedVersion: null,
  draftVersion: 1,
  updatedAt: '2026-08-27T00:00:00Z',
  ...o,
});

const version = (n: number, status: AssetVersionSummary['status']): AssetVersionSummary => ({
  assetId: 'a1',
  version: n,
  status,
  definition: {
    kind: 'agent',
    instructions: 'x',
    modelAlias: 'chat-fast',
    tools: [],
    knowledge: [],
  },
  updatedAt: '2026-08-27T00:00:00Z',
  revision: 1,
});

describe('toCard', () => {
  it('reads as draft only before anything is published', () => {
    expect(toCard(asset()).statusLabel).toBe('draft only');
  });

  // The resting state after publishing: nothing is open, so nothing is pending.
  it('reads as published when there is no open draft', () => {
    const card = toCard(asset({ publishedVersion: 1, draftVersion: null }));
    expect(card.hasUnpublishedChanges).toBe(false);
    expect(card.statusLabel).toBe('published');
  });

  it('reads as unpublished changes once a draft is opened above it', () => {
    const card = toCard(asset({ publishedVersion: 1, draftVersion: 2 }));
    expect(card.hasUnpublishedChanges).toBe(true);
    expect(card.statusLabel).toBe('unpublished changes');
  });
});

describe('toDetail', () => {
  const detail: AssetDetail = {
    ...asset({ publishedVersion: 1, draftVersion: 2 }),
    versions: [version(1, 'published'), version(2, 'draft')],
  };

  it('separates what runs from what is edited', () => {
    const result = toDetail(detail);
    expect(result.live?.version).toBe(1);
    expect(result.live?.status).toBe('published');
    expect(result.draft?.version).toBe(2);
    expect(result.draft?.status).toBe('draft');
  });

  it('lists versions newest first', () => {
    expect(toDetail(detail).versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('has no live version when nothing is published', () => {
    const result = toDetail({ ...asset(), versions: [version(1, 'draft')] });
    expect(result.live).toBeUndefined();
    expect(result.draft?.version).toBe(1);
  });
});

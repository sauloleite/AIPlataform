import { describe, expect, it } from 'vitest';

import {
  toAssetResponse,
  toDefinitionResponse,
  toVersionResponse,
} from '../src/modules/assets/presentation/http/mappers.js';
import type { AssetVersionView, AssetView } from '../src/modules/assets/application/dto.js';

/**
 * The wire is snake_case because the contract says so.
 *
 * Serialising an application view straight out of the controller shipped an API
 * that did not match its own published YAML — and no test noticed, because every
 * consumer had been written against what the service actually emitted.
 */

const ASSET: AssetView = {
  id: 'a1',
  projectId: 'p1',
  kind: 'agent',
  slug: 'support',
  name: 'Support',
  ownerPrincipalId: 'u1',
  publishedVersion: 2,
  draftVersion: null,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
};

describe('toAssetResponse', () => {
  it('names every field the way the contract does', () => {
    expect(Object.keys(toAssetResponse(ASSET)).sort()).toEqual([
      'created_at',
      'draft_version',
      'id',
      'kind',
      'name',
      'owner_principal_id',
      'project_id',
      'published_version',
      'slug',
      'updated_at',
    ]);
  });

  it('keeps a null published version as null, not absent', () => {
    // The console tells "never published" from "published version 0" by this
    // field being present and null.
    const response = toAssetResponse({ ...ASSET, publishedVersion: null });
    expect(response).toHaveProperty('published_version', null);
  });
});

describe('toVersionResponse', () => {
  const version: AssetVersionView = {
    assetId: 'a1',
    version: 2,
    status: 'published',
    definition: {
      kind: 'agent',
      instructions: 'help',
      modelAlias: 'chat-fast',
      tools: [{ assetId: 't1', version: null }],
      knowledge: [{ storeId: 's1' }],
      maxOutputTokens: 900,
    },
    publishedAt: '2026-08-02T00:00:00Z',
    publishedBy: 'u1',
    updatedAt: '2026-08-02T00:00:00Z',
    revision: 5,
  };

  it('translates the version envelope', () => {
    const response = toVersionResponse(version);

    expect(response['asset_id']).toBe('a1');
    expect(response['published_at']).toBe('2026-08-02T00:00:00Z');
    expect(response['published_by']).toBe('u1');
    expect(response['updated_at']).toBe('2026-08-02T00:00:00Z');
  });

  it('reports an unpublished draft as a null date rather than omitting it', () => {
    const draft: AssetVersionView = { ...version, status: 'draft' };
    delete draft.publishedAt;
    delete draft.publishedBy;

    const response = toVersionResponse(draft);

    expect(response).toHaveProperty('published_at', null);
    expect(response).toHaveProperty('published_by', null);
  });
});

describe('toDefinitionResponse', () => {
  it('translates an agent, references included', () => {
    const response = toDefinitionResponse({
      kind: 'agent',
      instructions: 'help',
      modelAlias: 'chat-fast',
      tools: [{ assetId: 't1', version: 3 }],
      knowledge: [{ storeId: 's1' }],
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 900,
    });

    expect(response).toEqual({
      kind: 'agent',
      instructions: 'help',
      model_alias: 'chat-fast',
      tools: [{ asset_id: 't1', version: 3 }],
      knowledge: [{ store_id: 's1' }],
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 900,
    });
  });

  it('translates a tool', () => {
    const response = toDefinitionResponse({
      kind: 'tool',
      toolType: 'builtin',
      riskLevel: 'high',
      builtinId: 'file_search',
    });

    expect(response).toEqual({
      kind: 'tool',
      tool_type: 'builtin',
      risk_level: 'high',
      builtin_id: 'file_search',
    });
  });

  it('never emits a connection secret it was not given', () => {
    const response = toDefinitionResponse({
      kind: 'tool',
      toolType: 'mcp',
      riskLevel: 'low',
      endpoint: 'https://tools.example/mcp',
    });

    expect(response).not.toHaveProperty('connection_id');
  });

  it('translates a prompt', () => {
    expect(
      toDefinitionResponse({ kind: 'prompt', template: 'Hi {name}', variables: ['name'] }),
    ).toEqual({ kind: 'prompt', template: 'Hi {name}', variables: ['name'] });
  });
});

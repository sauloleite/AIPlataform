import { describe, expect, it } from 'vitest';

import { HttpKnowledgeGateway } from '../src/modules/knowledge/infrastructure/http/knowledge-gateway';
import { HttpRegistryGateway } from '../src/modules/registry/infrastructure/http/registry-gateway';
import { HttpToolsGateway } from '../src/modules/tools/infrastructure/http/tools-gateway';

/**
 * The console read against the wire the services HAPPENED to emit, not against
 * the wire the contracts declare — camelCase where the YAML says snake_case.
 * Nothing caught it, because every other test here talks to a fake that speaks
 * the console's own vocabulary.
 *
 * So these feed each adapter a body copied from `contracts/openapi/*.yaml` and
 * assert what comes out. An adapter reading the wrong key produces `undefined`,
 * which is a blank cell in the console rather than an error anybody notices.
 */

function respondWith(payload: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('the registry adapter reads the contract shape', () => {
  it('maps an asset', async () => {
    const gateway = new HttpRegistryGateway(
      'http://registry',
      respondWith({
        items: [
          {
            id: 'a1',
            project_id: 'p1',
            kind: 'agent',
            slug: 'support',
            name: 'Support',
            owner_principal_id: 'u1',
            published_version: 3,
            draft_version: null,
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-02T00:00:00Z',
          },
        ],
      }),
    );

    const [asset] = await gateway.listAssets('token', 'p1');

    expect(asset?.publishedVersion).toBe(3);
    expect(asset?.draftVersion).toBeNull();
    expect(asset?.updatedAt).toBe('2026-08-02T00:00:00Z');
  });

  it('maps an agent definition, references included', async () => {
    const gateway = new HttpRegistryGateway(
      'http://registry',
      respondWith({
        asset_id: 'a1',
        version: 2,
        status: 'published',
        revision: 5,
        published_at: '2026-08-02T00:00:00Z',
        updated_at: '2026-08-02T00:00:00Z',
        definition: {
          kind: 'agent',
          instructions: 'help',
          model_alias: 'chat-fast',
          tools: [{ asset_id: 't1', version: null }],
          knowledge: [{ store_id: 's1' }],
          max_output_tokens: 900,
        },
      }),
    );

    const version = await gateway.publish('token', 'p1', 'a1');

    expect(version.assetId).toBe('a1');
    expect(version.publishedAt).toBe('2026-08-02T00:00:00Z');
    if (version.definition.kind !== 'agent') throw new Error('expected an agent');
    expect(version.definition.modelAlias).toBe('chat-fast');
    expect(version.definition.tools).toEqual([{ assetId: 't1', version: null }]);
    expect(version.definition.knowledge).toEqual([{ storeId: 's1' }]);
    expect(version.definition.maxOutputTokens).toBe(900);
  });

  it('maps a tool definition', async () => {
    const gateway = new HttpRegistryGateway(
      'http://registry',
      respondWith({
        asset_id: 't1',
        version: 1,
        status: 'published',
        revision: 1,
        updated_at: '2026-08-02T00:00:00Z',
        definition: {
          kind: 'tool',
          tool_type: 'builtin',
          risk_level: 'high',
          builtin_id: 'file_search',
        },
      }),
    );

    const version = await gateway.publish('token', 'p1', 't1');

    if (version.definition.kind !== 'tool') throw new Error('expected a tool');
    expect(version.definition.toolType).toBe('builtin');
    expect(version.definition.riskLevel).toBe('high');
    expect(version.definition.builtinId).toBe('file_search');
  });
});

describe('the knowledge adapter reads the contract shape', () => {
  it('maps a store, chunking included', async () => {
    const gateway = new HttpKnowledgeGateway(
      'http://knowledge',
      respondWith({
        items: [
          {
            id: 's1',
            project_id: 'p1',
            slug: 'handbook',
            name: 'Handbook',
            embedding_alias: 'embedding-default',
            embedding_model: 'nomic-embed-text',
            dimensions: 768,
            chunking: { kind: 'markdown-heading', max_tokens: 512, overlap_tokens: 64 },
            document_count: 4,
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-02T00:00:00Z',
          },
        ],
        next_cursor: null,
      }),
    );

    const [store] = await gateway.listStores('token', 'p1');

    expect(store?.embeddingAlias).toBe('embedding-default');
    expect(store?.dimensions).toBe(768);
    expect(store?.documentCount).toBe(4);
    expect(store?.chunking).toEqual({
      kind: 'markdown-heading',
      maxTokens: 512,
      overlapTokens: 64,
    });
  });

  it('maps a search hit, which is what a citation is drawn from', async () => {
    const gateway = new HttpKnowledgeGateway(
      'http://knowledge',
      respondWith({
        results: [
          {
            document_id: 'd1',
            document_title: 'Handbook',
            chunk_index: 7,
            score: 0.71,
            text: '30 days',
          },
        ],
      }),
    );

    const [hit] = await gateway.search('token', 'p1', 's1', { query: 'leave', topK: 5 });

    expect(hit?.documentId).toBe('d1');
    expect(hit?.documentTitle).toBe('Handbook');
    expect(hit?.chunkIndex).toBe(7);
  });
});

describe('the tools adapter reads the contract shape', () => {
  it('maps an effective tool', async () => {
    const gateway = new HttpToolsGateway(
      'http://gateway',
      respondWith({
        items: [
          {
            tool_id: 't1',
            slug: 'knowledge-search',
            name: 'Knowledge search',
            description: 'Retrieval',
            tool_type: 'builtin',
            risk_level: 'high',
            requires_approval: true,
            rate_limit_per_minute: 3,
          },
        ],
        next_cursor: null,
      }),
    );

    const [tool] = await gateway.listEffective('token', 'p1');

    expect(tool?.toolId).toBe('t1');
    expect(tool?.slug).toBe('knowledge-search');
    expect(tool?.riskLevel).toBe('high');
    // The one that matters: a tool needing approval must not render as one that
    // does not, and `undefined` is falsy.
    expect(tool?.requiresApproval).toBe(true);
    expect(tool?.rateLimitPerMinute).toBe(3);
  });

  it('maps a binding', async () => {
    const gateway = new HttpToolsGateway(
      'http://gateway',
      respondWith({
        items: [
          {
            project_id: 'p1',
            tool_id: 't1',
            enabled: true,
            rate_limit_per_minute: null,
            require_approval: null,
            updated_at: '2026-08-02T00:00:00Z',
          },
        ],
      }),
    );

    const [binding] = await gateway.listBindings('token', 'p1');

    expect(binding?.toolId).toBe('t1');
    expect(binding?.enabled).toBe(true);
    expect(binding?.rateLimitPerMinute).toBeNull();
  });
});

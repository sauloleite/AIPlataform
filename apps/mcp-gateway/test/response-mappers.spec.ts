import { describe, expect, it } from 'vitest';

import {
  toBindingResponse,
  toEffectiveToolResponse,
  toInvocationResponse,
} from '../src/modules/tools/presentation/http/mappers.js';
import type { EffectiveToolView } from '../src/modules/tools/application/dto.js';

/** The wire is snake_case because `contracts/openapi/mcp-gateway.v1.yaml` says so. */

const TOOL: EffectiveToolView = {
  toolId: 't1',
  slug: 'knowledge-search',
  name: 'Knowledge search',
  description: 'Retrieval from a vector store',
  toolType: 'builtin',
  riskLevel: 'high',
  requiresApproval: true,
  rateLimitPerMinute: 3,
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
};

describe('toEffectiveToolResponse', () => {
  it('names every field the way the contract does', () => {
    expect(Object.keys(toEffectiveToolResponse(TOOL)).sort()).toEqual([
      'description',
      'name',
      'parameters',
      'rate_limit_per_minute',
      'requires_approval',
      'risk_level',
      'slug',
      'tool_id',
      'tool_type',
    ]);
  });

  it('reports the approval requirement as a real boolean', () => {
    // Read under the wrong key this is `undefined`, which is falsy: a tool that
    // needs a human would render as one that does not.
    expect(toEffectiveToolResponse(TOOL)['requires_approval']).toBe(true);
  });

  it('carries the slug, which is what a model is told to call', () => {
    // `name` is a human label and may hold spaces; it would not survive a
    // provider round trip as a function name.
    expect(toEffectiveToolResponse(TOOL)['slug']).toBe('knowledge-search');
  });

  it('keeps an absent rate limit as null, meaning the platform default', () => {
    const response = toEffectiveToolResponse({ ...TOOL, rateLimitPerMinute: null });
    expect(response).toHaveProperty('rate_limit_per_minute', null);
  });

  it('leaves out a description the tool never had', () => {
    const withoutDescription: EffectiveToolView = { ...TOOL };
    delete withoutDescription.description;

    expect(toEffectiveToolResponse(withoutDescription)).not.toHaveProperty('description');
  });
});

describe('toBindingResponse', () => {
  it('translates a binding', () => {
    expect(
      toBindingResponse({
        projectId: 'p1',
        toolId: 't1',
        enabled: true,
        rateLimitPerMinute: 60,
        requireApproval: null,
        updatedAt: '2026-08-02T00:00:00Z',
      }),
    ).toEqual({
      project_id: 'p1',
      tool_id: 't1',
      enabled: true,
      rate_limit_per_minute: 60,
      require_approval: null,
      updated_at: '2026-08-02T00:00:00Z',
    });
  });
});

describe('toInvocationResponse', () => {
  it('translates a result without touching what the tool returned', () => {
    const result = { hits: [{ score: 0.7 }] };

    expect(toInvocationResponse({ toolId: 't1', status: 'ok', result, durationMs: 486 })).toEqual({
      tool_id: 't1',
      status: 'ok',
      result,
      duration_ms: 486,
    });
  });
});

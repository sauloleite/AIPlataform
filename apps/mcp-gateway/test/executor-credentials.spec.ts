import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpExecutor } from '../src/modules/tools/infrastructure/executors/mcp-executor.js';
import { OpenApiExecutor } from '../src/modules/tools/infrastructure/executors/openapi-executor.js';
import { KnowledgeSearchExecutor } from '../src/modules/tools/infrastructure/executors/knowledge-search-executor.js';
import type { ToolInvocation } from '../src/modules/tools/application/ports.js';
import type { ToolDefinition } from '../src/modules/tools/domain/value-objects/index.js';

/**
 * What an external endpoint is allowed to receive.
 *
 * The gateway used to send the caller's platform token to MCP servers and
 * OpenAPI endpoints. That token is a valid AIA JWT: whoever holds one can turn
 * round and act as that user against this platform, reading their projects and
 * spending their budget (ADR-020). An external tool gets its CONNECTION's
 * credential and nothing else.
 */

const PLATFORM_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.a-real-platform-jwt.signature';

const captured: { url: string; headers: Record<string, string> }[] = [];

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    toolId: 't1',
    slug: 'ticket-lookup',
    name: 'Ticket lookup',
    toolType: 'mcp',
    riskLevel: 'low',
    endpoint: 'https://tools.example/mcp',
    ...overrides,
  };
}

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    tool: tool(),
    arguments: { id: 42 },
    accessToken: PLATFORM_TOKEN,
    projectId: 'p1',
    principalId: 'user-ana',
    ...overrides,
  };
}

function headersOf(index = 0): Record<string, string> {
  return captured[index]?.headers ?? {};
}

beforeEach(() => {
  captured.length = 0;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ result: { content: 'ok' }, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an MCP server', () => {
  it('never receives the platform token', async () => {
    await new McpExecutor().execute(invocation());

    expect(JSON.stringify(headersOf())).not.toContain(PLATFORM_TOKEN);
    expect(headersOf()['Authorization']).toBeUndefined();
  });

  it('receives the connection credential when the tool has one', async () => {
    await new McpExecutor().execute(
      invocation({ credential: { header: 'Authorization', value: 'Bearer sk-tool' } }),
    );

    expect(headersOf()['Authorization']).toBe('Bearer sk-tool');
  });

  it('still says which project is asking', async () => {
    // Who is asking travels as a project header and in the audit record, not
    // as a bearer token somebody else can spend.
    await new McpExecutor().execute(invocation());

    expect(headersOf()['X-Project-Id']).toBe('p1');
  });
});

describe('an OpenAPI endpoint', () => {
  it('never receives the platform token', async () => {
    await new OpenApiExecutor().execute(
      invocation({ tool: tool({ toolType: 'openapi', endpoint: 'https://api.example/do' }) }),
    );

    expect(JSON.stringify(headersOf())).not.toContain(PLATFORM_TOKEN);
    expect(headersOf()['Authorization']).toBeUndefined();
  });

  it('receives the connection credential in the header the operator chose', async () => {
    await new OpenApiExecutor().execute(
      invocation({
        tool: tool({ toolType: 'openapi', endpoint: 'https://api.example/do' }),
        credential: { header: 'X-Api-Key', value: 'sk-tool' },
      }),
    );

    expect(headersOf()['X-Api-Key']).toBe('sk-tool');
    expect(headersOf()['Authorization']).toBeUndefined();
  });
});

describe('the file_search built-in', () => {
  it('DOES carry the platform token, because it reaches aia-knowledge', async () => {
    // The distinction that matters: an internal service authorises the person
    // (ADR-017), so the search is trimmed to what they may read. A built-in
    // that searched as the gateway would hand every document to whoever asked.
    await new KnowledgeSearchExecutor('http://knowledge:3007').execute(
      invocation({
        tool: tool({ toolType: 'builtin', builtinId: 'file_search' }),
        arguments: { store_id: 's1', query: 'leave' },
      }),
    );

    expect(headersOf()['Authorization']).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect(captured[0]?.url).toContain('http://knowledge:3007');
  });
});

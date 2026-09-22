import { describe, expect, it } from 'vitest';

import type { ToolInvocation } from '../src/modules/tools/application/ports.js';
import {
  InvalidToolArgumentsError,
  ToolExecutionFailedError,
} from '../src/modules/tools/domain/errors/index.js';
import {
  builtinToolId,
  findBuiltinTool,
} from '../src/modules/tools/domain/value-objects/builtin-tools.js';
import { WebSearchExecutor } from '../src/modules/tools/infrastructure/executors/web-search-executor.js';
import { GovernanceClassificationReader } from '../src/modules/tools/infrastructure/http/governance-classification-reader.js';
import {
  SearxngBackend,
  TavilyBackend,
} from '../src/modules/tools/infrastructure/web-search/search-backends.js';
import { FakeSecretResolver } from './fakes.js';

/** The web-search built-in and its backends, against a fake of each HTTP API. */

const WEB_SEARCH = findBuiltinTool(builtinToolId('web_search'))!;

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers from a function and remembers what it was asked. */
function fakeFetch(answer: (url: string) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (url, init) => {
    const href = url instanceof Request ? url.url : url.toString();
    seen.push({ url: href, init });
    return answer(href);
  };
  return { fetch: impl, seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function search(executor: WebSearchExecutor, args: Record<string, unknown>) {
  const invocation: ToolInvocation = {
    tool: WEB_SEARCH,
    arguments: args,
    accessToken: 'caller-token',
    projectId: 'p1',
    principalId: 'user-ana',
  };
  return executor.execute(invocation);
}

describe('SearXNG', () => {
  const RESULTS = {
    results: [
      {
        title: 'Brazil - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/Brazil',
        content: 'Brazil is…',
      },
      { title: '', url: 'https://example.com/untitled', content: 'x'.repeat(2000) },
      { title: 'Not a web page', url: 'javascript:alert(1)', content: 'nope' },
      'garbage',
    ],
  };

  it('asks for JSON with safe search, and maps the results', async () => {
    const api = fakeFetch(() => json(RESULTS));
    const executor = new WebSearchExecutor(new SearxngBackend('http://searxng:8080', api.fetch));

    const { result } = await search(executor, { query: 'brazil' });

    const asked = new URL(api.seen[0]!.url);
    expect(asked.pathname).toBe('/search');
    expect(asked.searchParams.get('format')).toBe('json');
    expect(asked.searchParams.get('safesearch')).toBe('1');
    const { query, results } = result as { query: string; results: unknown[] };
    expect(query).toBe('brazil');
    expect(results[0]).toEqual({
      title: 'Brazil - Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Brazil',
      snippet: 'Brazil is…',
    });
  });

  it('drops a result whose URL is not a web page, and titles an untitled one by its URL', async () => {
    const executor = new WebSearchExecutor(
      new SearxngBackend('http://searxng:8080', fakeFetch(() => json(RESULTS)).fetch),
    );

    const { results } = (await search(executor, { query: 'brazil' })).result as {
      results: { title: string; url: string; snippet: string }[];
    };

    expect(results.map((hit) => hit.url)).not.toContain('javascript:alert(1)');
    expect(results[1]?.title).toBe('https://example.com/untitled');
    expect(results[1]?.snippet.length).toBeLessThanOrEqual(501);
  });

  it('explains a 403, which is SearXNG without the JSON format enabled', async () => {
    const executor = new WebSearchExecutor(
      new SearxngBackend(
        'http://searxng:8080',
        fakeFetch(() => new Response('', { status: 403 })).fetch,
      ),
    );

    const failure = search(executor, { query: 'brazil' });
    await expect(failure).rejects.toThrow(ToolExecutionFailedError);
    await expect(failure).rejects.toThrow(/json format/);
  });

  it('fails plainly when the answer carries no result list', async () => {
    const executor = new WebSearchExecutor(
      new SearxngBackend('http://searxng:8080', fakeFetch(() => json({ error: 'busy' })).fetch),
    );

    await expect(search(executor, { query: 'brazil' })).rejects.toThrow(ToolExecutionFailedError);
  });
});

describe('Tavily', () => {
  it('sends the key from the secret resolver, never from configuration', async () => {
    const api = fakeFetch(() =>
      json({ results: [{ title: 'T', url: 'https://t.example/', content: 'c' }] }),
    );
    const backend = new TavilyBackend(
      new FakeSecretResolver({ 'tavily-api-key': 'tvly-123' }),
      'tavily-api-key',
      api.fetch,
    );

    await search(new WebSearchExecutor(backend), { query: 'news', max_results: 3 });

    const headers = api.seen[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tvly-123');
    expect(JSON.parse(api.seen[0]?.init?.body as string)).toMatchObject({
      query: 'news',
      max_results: 3,
    });
  });

  it('is unavailable when the key was never mounted, naming the reference and not a value', async () => {
    const backend = new TavilyBackend(
      new FakeSecretResolver({}),
      'tavily-api-key',
      fakeFetch(() => json({})).fetch,
    );

    const reason = await new WebSearchExecutor(backend).unavailableReason();

    expect(reason).toContain('"tavily-api-key"');
  });

  it('fails a call made anyway without sending anything', async () => {
    const api = fakeFetch(() => json({}));
    const backend = new TavilyBackend(new FakeSecretResolver({}), 'tavily-api-key', api.fetch);

    await expect(search(new WebSearchExecutor(backend), { query: 'news' })).rejects.toThrow(
      ToolExecutionFailedError,
    );
    expect(api.seen).toHaveLength(0);
  });

  it('reports an upstream error status', async () => {
    const backend = new TavilyBackend(
      new FakeSecretResolver({ 'tavily-api-key': 'tvly-123' }),
      'tavily-api-key',
      fakeFetch(() => json({ detail: 'bad key' }, 401)).fetch,
    );

    await expect(search(new WebSearchExecutor(backend), { query: 'news' })).rejects.toThrow('401');
  });
});

describe('the web-search executor', () => {
  const backend = (): { executor: WebSearchExecutor; seen: Seen[] } => {
    const api = fakeFetch(() =>
      json({
        results: Array.from({ length: 30 }, (_, i) => ({
          title: `r${i.toString()}`,
          url: `https://r${i.toString()}.example/`,
          content: '',
        })),
      }),
    );
    return {
      executor: new WebSearchExecutor(new SearxngBackend('http://searxng:8080', api.fetch)),
      seen: api.seen,
    };
  };

  it('is unavailable, saying which setting, when no backend is configured', async () => {
    expect(await new WebSearchExecutor(null).unavailableReason()).toContain('WEB_SEARCH_PROVIDER');
    await expect(search(new WebSearchExecutor(null), { query: 'x' })).rejects.toThrow(
      ToolExecutionFailedError,
    );
  });

  it.each([
    ['no query', {}],
    ['a blank query', { query: '   ' }],
    ['a query that is not a string', { query: ['a', 'b'] }],
    ['a query longer than the limit', { query: 'x'.repeat(401) }],
  ])('refuses %s as a bad argument, before asking the backend', async (_case, args) => {
    const { executor, seen } = backend();

    await expect(search(executor, args)).rejects.toThrow(InvalidToolArgumentsError);
    expect(seen).toHaveLength(0);
  });

  it.each([
    [undefined, 5],
    [3, 3],
    [50, 10],
    [0, 1],
    ['7', 5],
  ])('reads max_results %s as %s', async (maxResults, expected) => {
    const { executor } = backend();

    const { result } = await search(executor, { query: 'x', max_results: maxResults });

    expect((result as { results: unknown[] }).results).toHaveLength(expected);
  });
});

describe('the classification reader', () => {
  it('reads as the caller, and caches a success for the project', async () => {
    const api = fakeFetch(() => json({ data_classification: 'confidential' }));
    const reader = new GovernanceClassificationReader('http://governance:3002', api.fetch);

    expect(await reader.classificationOf({ projectId: 'p1', accessToken: 'caller-token' })).toBe(
      'confidential',
    );
    expect(await reader.classificationOf({ projectId: 'p1', accessToken: 'caller-token' })).toBe(
      'confidential',
    );

    expect(api.seen).toHaveLength(1);
    expect((api.seen[0]?.init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer caller-token',
    );
    expect(api.seen[0]?.url).toBe('http://governance:3002/v1/projects/p1/policy');
  });

  it('asks again once the cached value is old', async () => {
    let now = 0;
    const api = fakeFetch(() => json({ data_classification: 'internal' }));
    const reader = new GovernanceClassificationReader(
      'http://governance:3002',
      api.fetch,
      () => now,
    );

    await reader.classificationOf({ projectId: 'p1', accessToken: 't' });
    now = 31_000;
    await reader.classificationOf({ projectId: 'p1', accessToken: 't' });

    expect(api.seen).toHaveLength(2);
  });

  it('never caches a failure, so the next call can succeed', async () => {
    let status = 503;
    const api = fakeFetch(() =>
      status === 200 ? json({ data_classification: 'public' }) : json({}, status),
    );
    const reader = new GovernanceClassificationReader('http://governance:3002', api.fetch);

    await expect(reader.classificationOf({ projectId: 'p1', accessToken: 't' })).rejects.toThrow();
    status = 200;

    expect(await reader.classificationOf({ projectId: 'p1', accessToken: 't' })).toBe('public');
  });

  it('refuses a policy that carries no classification instead of assuming one', async () => {
    const reader = new GovernanceClassificationReader(
      'http://governance:3002',
      fakeFetch(() => json({})).fetch,
    );

    await expect(reader.classificationOf({ projectId: 'p1', accessToken: 't' })).rejects.toThrow(
      /without a classification/,
    );
  });

  it('refuses when no governance is configured at all', async () => {
    const reader = new GovernanceClassificationReader('');

    await expect(reader.classificationOf({ projectId: 'p1', accessToken: 't' })).rejects.toThrow(
      /GOVERNANCE_URL/,
    );
  });
});

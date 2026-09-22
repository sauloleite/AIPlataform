/**
 * Where the web-search built-in gets its results.
 *
 * Not an application port: nothing outside this adapter chooses a backend.
 * The executor is the port's implementation, and a backend is the detail of
 * how it implements it -- the same way `McpExecutor` does not expose its
 * JSON-RPC client.
 *
 * Two backends, for the two ways this platform is run. SearXNG is open source
 * and self-hosted, so a fresh `make dev` searches with no account and no key
 * (ADR-012). Tavily is a hosted API built for agents, for an operator who would
 * rather pay than run a metasearch engine.
 */
import type { SecretResolver } from '../../application/ports.js';

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchBackend {
  /** The circuit-breaker key, so one backend failing does not trip another. */
  readonly name: string;
  unavailableReason(): Promise<string | null>;
  search(input: { query: string; maxResults: number; signal: AbortSignal }): Promise<SearchHit[]>;
}

/** The backend answered, but not with what a search answers with. */
export class SearchBackendError extends Error {}

/**
 * A snippet is page text a stranger wrote. Kept short: it is there to help the
 * model choose what to read, and every character is one more place for an
 * injected instruction to hide.
 */
const MAX_SNIPPET = 500;

export class SearxngBackend implements SearchBackend {
  readonly name = 'web-search:searxng';

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async unavailableReason(): Promise<string | null> {
    return this.baseUrl === ''
      ? 'Web search is set to SearXNG, but WEB_SEARCH_SEARXNG_URL is empty'
      : null;
  }

  async search(input: {
    query: string;
    maxResults: number;
    signal: AbortSignal;
  }): Promise<SearchHit[]> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', input.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '1');

    const response = await this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: input.signal,
    });
    if (response.status === 403) {
      // SearXNG's answer when `json` is missing from `search.formats`. Said
      // plainly, because the 403 alone reads like a permissions problem.
      throw new SearchBackendError(
        'SearXNG refused a JSON search; enable the json format in its settings.yml',
      );
    }
    if (!response.ok) {
      throw new SearchBackendError(`SearXNG answered ${response.status.toString()}`);
    }

    const body = (await response.json()) as { results?: unknown };
    return hitsFrom(body.results, 'content').slice(0, input.maxResults);
  }
}

export class TavilyBackend implements SearchBackend {
  readonly name = 'web-search:tavily';

  constructor(
    private readonly secrets: SecretResolver,
    private readonly secretRef: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpoint = 'https://api.tavily.com/search',
  ) {}

  async unavailableReason(): Promise<string | null> {
    // The reference, never the value: this reason is shown in the console.
    return (await this.secrets.resolve(this.secretRef)) === null
      ? `Web search is set to Tavily, but the secret "${this.secretRef}" is not available on this host`
      : null;
  }

  async search(input: {
    query: string;
    maxResults: number;
    signal: AbortSignal;
  }): Promise<SearchHit[]> {
    // Resolved per call, never held: a key that lives only for one request
    // cannot be serialised into a log by accident, and a rotated one is picked
    // up without a restart.
    const key = await this.secrets.resolve(this.secretRef);
    if (key === null) {
      throw new SearchBackendError(`The secret "${this.secretRef}" is not available on this host`);
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: input.query,
        max_results: input.maxResults,
        search_depth: 'basic',
        include_answer: false,
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new SearchBackendError(`Tavily answered ${response.status.toString()}`);
    }

    const body = (await response.json()) as { results?: unknown };
    return hitsFrom(body.results, 'content').slice(0, input.maxResults);
  }
}

/** Both backends answer `{title, url, content}`; anything else is dropped, not guessed at. */
function hitsFrom(raw: unknown, snippetField: string): SearchHit[] {
  if (!Array.isArray(raw)) {
    throw new SearchBackendError('The search backend answered without a result list');
  }

  return raw.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const url = record['url'];
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return [];

    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const snippet = typeof record[snippetField] === 'string' ? record[snippetField].trim() : '';
    return [
      {
        title: title === '' ? url : title,
        url,
        snippet: snippet.length > MAX_SNIPPET ? `${snippet.slice(0, MAX_SNIPPET)}…` : snippet,
      },
    ];
  });
}

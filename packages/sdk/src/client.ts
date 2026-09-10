import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { errorFrom } from './errors.js';
import type {
  Aia,
  AiaOptions,
  Approval,
  ChatEvent,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  ModelAlias,
  Run,
  RunInput,
  SearchQuery,
  SearchResult,
  TokenSource,
} from './types.js';

/**
 * The platform, over HTTP.
 *
 * Three things this does that a hand-written `fetch` wrapper in each consumer
 * would not: it applies the platform's own resilience policies rather than a
 * guess at a timeout, it turns Problem Details into an exception carrying the
 * stable code and the trace id, and it puts the tenant on every request. The
 * third is the one that matters most -- `X-Project-Id` forgotten on one call
 * out of forty is a 400 in production and nowhere else.
 */
export class AiaClient implements Aia {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly token: TokenSource;
  private readonly fetch: typeof globalThis.fetch;

  // The policies are the platform's, not this client's. A consumer that
  // invented its own timeout would either give up before the router's own
  // ceiling -- turning a slow answer into a failed one -- or wait past it.
  private readonly inference = new ResilienceExecutor(POLICIES.INFERENCE);
  private readonly embeddings = new ResilienceExecutor(POLICIES.EMBEDDINGS);
  private readonly platform = new ResilienceExecutor(POLICIES.INTERNAL);

  constructor(options: AiaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.projectId = options.projectId;
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    return this.json<ChatResult>(
      'POST',
      '/v1/chat/completions',
      { executor: this.inference, route: 'chat' },
      { ...request, stream: false },
    );
  }

  /**
   * The stream, event by event.
   *
   * No `ResilienceExecutor` here, and that is the policy rather than an
   * omission: `POLICIES.INFERENCE_STREAMING` allows a retry only before the
   * first token, and once bytes have reached the caller there is nothing to
   * retry into -- replaying would repeat text the caller already has. A failure
   * after the first token arrives as an `error` event, which is exactly how the
   * router sends it.
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const response = await this.send('POST', '/v1/chat/completions', {
      ...request,
      stream: true,
    });
    if (!response.ok) throw await errorFrom(response, '/v1/chat/completions');
    if (response.body === null) return;

    for await (const frame of readEventStream(response.body)) {
      if (frame.event === 'message.delta') {
        const data = frame.data as { delta?: { content?: string } };
        const content = data.delta?.content ?? '';
        if (content !== '') yield { kind: 'delta', content };
        continue;
      }
      if (frame.event === 'run.finished') {
        yield { kind: 'finished', result: frame.data as ChatResult };
        continue;
      }
      if (frame.event === 'error') {
        const data = frame.data as { code?: string; message?: string };
        yield {
          kind: 'error',
          code: data.code ?? 'internal_error',
          message: data.message ?? 'The stream failed',
        };
      }
    }
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    return this.json<EmbedResult>(
      'POST',
      '/v1/embeddings',
      { executor: this.embeddings, route: 'embeddings' },
      request,
    );
  }

  async models(): Promise<ModelAlias[]> {
    const page = await this.json<{ data: ModelAlias[] }>('GET', '/v1/models', {
      executor: this.platform,
      route: 'models',
    });
    return page.data;
  }

  async search(storeId: string, request: SearchQuery): Promise<SearchResult> {
    return this.json<SearchResult>(
      'POST',
      `/v1/stores/${encodeURIComponent(storeId)}/search`,
      { executor: this.platform, route: 'search' },
      request,
    );
  }

  async startRun(agentId: string, request: RunInput): Promise<Run> {
    // A run holds a model call, so it gets the inference policy and not the
    // two-second one meant for reading a policy document.
    return this.json<Run>(
      'POST',
      `/v1/agents/${encodeURIComponent(agentId)}/runs`,
      { executor: this.inference, route: 'runs' },
      request,
    );
  }

  async getRun(runId: string): Promise<Run> {
    return this.json<Run>('GET', `/v1/runs/${encodeURIComponent(runId)}`, {
      executor: this.platform,
      route: 'run',
    });
  }

  async approve(runId: string, decision: Approval): Promise<Run> {
    return this.json<Run>(
      'POST',
      `/v1/runs/${encodeURIComponent(runId)}/approve`,
      { executor: this.inference, route: 'approve' },
      decision,
    );
  }

  private async json<T>(
    method: string,
    path: string,
    call: { executor: ResilienceExecutor; route: string },
    body?: unknown,
  ): Promise<T> {
    return call.executor.execute(
      async (signal) => {
        const response = await this.send(method, path, body, signal);
        if (!response.ok) throw await errorFrom(response, path);
        return (await response.json()) as T;
      },
      // Keyed by ROUTE, not by path: `/v1/runs/{id}` is one dependency, and a
      // key carrying the id would open a fresh circuit for every run -- a
      // breaker that has never seen a second call cannot break.
      { key: call.route },
    );
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = typeof this.token === 'string' ? this.token : await this.token();
    return this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Project-Id': this.projectId,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(method === 'POST' && path.endsWith('/completions') && { Accept: 'text/event-stream' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal !== undefined && { signal }),
    });
  }
}

interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Server-Sent Events, parsed.
 *
 * Frames are separated by a blank line and a frame can be split across network
 * chunks, so the buffer is what makes this correct: reading each chunk as a
 * whole frame works on a fast local connection and truncates a JSON payload the
 * first time a real network splits one.
 */
async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = parseFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (frame !== undefined) yield frame;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let event = 'message';
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim());
  }

  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    // Everything that carries nothing usable leaves here: a heartbeat (`: ping`
    // is a comment with no `data:` line, and `JSON.parse('')` throws) and a
    // truncated payload alike. Two separate guards used to stand for those two
    // cases, and neither could be made to fail on its own, because each was
    // covered by the other.
    return undefined;
  }
}

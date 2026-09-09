import { describe, expect, it } from 'vitest';
import { ERROR_CODES, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@aia/errors';

import { AiaClient, FakeAia, PlatformError, type Aia } from '../src/index.js';

/** A `fetch` that answers from a table, so no socket is involved. */
function fetchReturning(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : new URL(input).href;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return { fetch: fake, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(partial: Partial<ProblemDetails> & { status: number }): Response {
  const body: ProblemDetails = {
    type: 'https://aia.dev/errors/budget_exhausted',
    title: 'Budget exhausted',
    detail: 'The project has spent its monthly budget',
    code: ERROR_CODES.BUDGET_EXHAUSTED,
    instance: '/v1/chat/completions',
    ...partial,
  };
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { 'Content-Type': PROBLEM_CONTENT_TYPE },
  });
}

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'chat-local',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

function clientWith(handler: Parameters<typeof fetchReturning>[0]): {
  client: AiaClient;
  calls: { url: string; init: RequestInit }[];
} {
  const { fetch, calls } = fetchReturning(handler);
  return {
    client: new AiaClient({
      baseUrl: 'http://platform.test/',
      projectId: 'proj-1',
      token: 'a-token',
      fetch,
    }),
    calls,
  };
}

describe('the tenant and the credential', () => {
  it('puts the project on every request', async () => {
    const { client, calls } = clientWith(() => json(COMPLETION));
    await client.chat({ model: 'chat-local', messages: [{ role: 'user', content: 'hi' }] });

    // The whole reason this lives in the client: `X-Project-Id` forgotten on
    // one call out of forty is a 400 in production and nowhere else.
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Project-Id']).toBe('proj-1');
    expect(headers.Authorization).toBe('Bearer a-token');
  });

  it('asks for a token again on every call when given a source', async () => {
    let issued = 0;
    const { fetch, calls } = fetchReturning(() => json(COMPLETION));
    const client = new AiaClient({
      baseUrl: 'http://platform.test',
      projectId: 'proj-1',
      token: () => {
        issued += 1;
        return `token-${issued.toString()}`;
      },
      fetch,
    });

    await client.chat({ model: 'chat-local', messages: [] });
    await client.chat({ model: 'chat-local', messages: [] });

    // A token that expires has to be re-read. Caching the first one here is how
    // a long-lived process starts failing with 401 an hour after it started.
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe('Bearer token-2');
  });

  it('does not double the slash when the base url ends in one', async () => {
    const { client, calls } = clientWith(() => json(COMPLETION));
    await client.chat({ model: 'chat-local', messages: [] });
    expect(calls[0]?.url).toBe('http://platform.test/v1/chat/completions');
  });
});

describe('what the platform refused', () => {
  it('raises the stable code, the status and the trace id', async () => {
    const { client } = clientWith(() =>
      problem({ status: 429, retry_after: 30, trace_id: 'abc123' }),
    );

    const failure = await client
      .chat({ model: 'chat-local', messages: [] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlatformError);
    const error = failure as PlatformError;
    expect(error.code).toBe('budget_exhausted');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    // Without this a bug report says "it failed" and nobody can find the trace.
    expect(error.traceId).toBe('abc123');
  });

  it('survives a proxy answering HTML instead of Problem Details', async () => {
    const { client } = clientWith(
      () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );

    const failure = await client.models().catch((error: unknown) => error);

    // A JSON parse error naming a line and column would hide the only fact that
    // is always known: the status.
    expect((failure as PlatformError).status).toBe(502);
    expect((failure as PlatformError).message).toContain('502');
  });
});

describe('streaming', () => {
  function sse(frames: string[]): Response {
    return new Response(frames.join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('reassembles a frame split across chunks', async () => {
    // One frame arriving in two pieces is the normal case on a real network and
    // never happens against a fake that returns whole frames.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: message.delta\ndata: {"delta":{"con'));
        controller.enqueue(encoder.encode('tent":"hello"}}\n\n'));
        controller.enqueue(
          encoder.encode(`event: run.finished\ndata: ${JSON.stringify(COMPLETION)}\n\n`),
        );
        controller.close();
      },
    });
    const { client } = clientWith(
      () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const events = [];
    for await (const event of client.chatStream({ model: 'chat-local', messages: [] })) {
      events.push(event);
    }

    expect(events).toEqual([
      { kind: 'delta', content: 'hello' },
      { kind: 'finished', result: COMPLETION },
    ]);
  });

  it('ignores the heartbeat', async () => {
    const { client } = clientWith(() =>
      sse([': ping\n\n', 'event: message.delta\ndata: {"delta":{"content":"hi"}}\n\n']),
    );

    const events = [];
    for await (const event of client.chatStream({ model: 'chat-local', messages: [] })) {
      events.push(event);
    }

    // A comment frame keeps a proxy from dropping the connection and means
    // nothing to the caller. Surfacing it as an empty delta would have every
    // consumer filtering it out.
    expect(events).toEqual([{ kind: 'delta', content: 'hi' }]);
  });

  it('reports a failure that arrives inside the stream', async () => {
    const { client } = clientWith(() =>
      sse(['event: error\ndata: {"code":"stream_interrupted","message":"upstream closed"}\n\n']),
    );

    const events = [];
    for await (const event of client.chatStream({ model: 'chat-local', messages: [] })) {
      events.push(event);
    }

    // The headers are long gone by then, so the status cannot say it. A
    // consumer that only checks for a thrown error would call this a success.
    expect(events).toEqual([
      { kind: 'error', code: 'stream_interrupted', message: 'upstream closed' },
    ]);
  });

  it('throws before the first event, where a status is still possible', async () => {
    const { client } = clientWith(() => problem({ status: 429 }));

    const iterator = client.chatStream({ model: 'chat-local', messages: [] });
    await expect(iterator.next()).rejects.toBeInstanceOf(PlatformError);
  });
});

/**
 * The design test.
 *
 * Whatever is written against `Aia` has to work against both implementations.
 * If a test needs to know which one it holds, the transport has leaked into the
 * interface.
 */
describe.each([
  ['the fake', () => new FakeAia({ reply: 'ok' }) as Aia],
  [
    'the client',
    () =>
      clientWith((url) => {
        if (url.endsWith('/v1/chat/completions')) return json(COMPLETION);
        if (url.endsWith('/v1/models')) {
          return json({ data: [{ id: 'chat-local', capabilities: ['chat'] }] });
        }
        return json({});
      }).client as Aia,
  ],
])('%s honours the same interface', (_name, build) => {
  it('answers a completion with the model it was asked for', async () => {
    const result = await build().chat({
      model: 'chat-local',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.model).toBe('chat-local');
    expect(result.choices[0]?.message.content).toBe('ok');
  });

  it('lists at least one alias', async () => {
    expect((await build().models())[0]?.id).toBe('chat-local');
  });
});

describe('the fake, as a test double', () => {
  it('needs no credential, no container and no network', async () => {
    // The point of the package. If this ever needs a URL or a token, the
    // interface has leaked its transport.
    const platform = new FakeAia({ reply: 'the answer' });
    const result = await platform.chat({ model: 'chat-local', messages: [] });
    expect(result.choices[0]?.message.content).toBe('the answer');
  });

  it('reproduces a refusal a real platform would make you earn', async () => {
    const platform = new FakeAia();
    platform.failWith('BUDGET_EXHAUSTED', 429);

    const failure = await platform
      .chat({ model: 'chat-local', messages: [] })
      .catch((error: unknown) => error);

    expect((failure as PlatformError).code).toBe('budget_exhausted');
    expect((failure as PlatformError).retryAfterSeconds).toBe(30);
    // Once. A failure that stuck would make every later call in the test fail
    // for a reason the test never asked for.
    await expect(platform.chat({ model: 'chat-local', messages: [] })).resolves.toBeDefined();
  });

  it('streams more than one delta', async () => {
    const platform = new FakeAia({ reply: 'one two three' });
    const contents = [];
    for await (const event of platform.chatStream({ model: 'chat-local', messages: [] })) {
      if (event.kind === 'delta') contents.push(event.content);
    }
    // A consumer that keeps only the last delta and one that concatenates them
    // look identical against a single chunk.
    expect(contents).toEqual(['one', 'two', 'three']);
  });

  it('holds a run for approval and resumes it', async () => {
    const platform = new FakeAia();
    const held = platform.holdForApproval('agent-1', 'file_search');
    expect(held.status).toBe('waiting_approval');

    const resumed = await platform.approve(held.id, { tool_call_id: 'call-1', approved: true });
    expect(resumed.status).toBe('completed');
    expect(resumed.pending_call).toBeNull();
  });

  it('refuses to approve a run that is not waiting', async () => {
    const platform = new FakeAia();
    const run = await platform.startRun('agent-1', { input: 'hello' });

    const failure = await platform
      .approve(run.id, { tool_call_id: 'call-1', approved: true })
      .catch((error: unknown) => error);

    // 409 and not 404: the run exists. A caller approving twice has to be able
    // to tell "already done" from "never existed".
    expect((failure as PlatformError).status).toBe(409);
  });

  it('searches what it was given and nothing else', async () => {
    const platform = new FakeAia({
      documents: [{ documentId: 'doc-1', title: 'Runbook', text: 'the code is ZORBLAX-7741' }],
    });

    expect((await platform.search('store-1', { query: 'zorblax' })).results).toHaveLength(1);
    expect((await platform.search('store-1', { query: 'nothing here' })).results).toHaveLength(0);
  });
});

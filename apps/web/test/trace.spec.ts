import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  attributesOf,
  detailOf,
  nanosToMs,
  orderForDisplay,
  toSpans,
  totalDuration,
  type OtlpTrace,
  type SpanView,
} from '../src/modules/observability/domain/trace';
import { escapeTraceQl } from '../src/modules/observability/infrastructure/http/tempo-gateway';

/**
 * Reading a trace.
 *
 * OTLP JSON is fiddly in ways that do not throw: an attribute is a `{key,
 * value}` pair rather than a property, and a timestamp is a nanosecond STRING
 * that loses its last digits if it is read as a number. Getting either wrong
 * renders a blank cell, and a blank cell reads as "the platform did not record
 * it".
 */

const BASE = 1_756_500_000_000_000_000n;

function nano(offsetMs: number): string {
  return String(BASE + BigInt(offsetMs) * 1_000_000n);
}

function span(
  name: string,
  spanId: string,
  options: {
    parent?: string;
    startMs?: number;
    durationMs?: number;
    attributes?: Record<string, string>;
    error?: boolean;
  } = {},
): Record<string, unknown> {
  const start = options.startMs ?? 0;
  return {
    spanId,
    ...(options.parent !== undefined && { parentSpanId: options.parent }),
    name,
    startTimeUnixNano: nano(start),
    endTimeUnixNano: nano(start + (options.durationMs ?? 10)),
    attributes: Object.entries(options.attributes ?? {}).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    })),
    ...(options.error === true && { status: { code: 2 } }),
  };
}

function trace(service: string, spans: Record<string, unknown>[]): OtlpTrace {
  return {
    batches: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

describe('nanosToMs', () => {
  it('does not lose precision on a real timestamp', () => {
    // `Number('1756500000000000000')` silently drops the last digits, and two
    // spans a microsecond apart then come out identical.
    expect(nanosToMs(nano(0))).toBe(1_756_500_000_000);
    expect(nanosToMs(nano(1)) - nanosToMs(nano(0))).toBe(1);
  });

  it('reads a number as happily as a string', () => {
    expect(nanosToMs(1_000_000)).toBe(1);
  });

  it('answers zero for something that is not a timestamp', () => {
    // A backend is data. Malformed data renders a zero, never an exception in
    // a server component.
    expect(nanosToMs(undefined)).toBe(0);
    expect(nanosToMs('not a number')).toBe(0);
  });
});

describe('attributesOf', () => {
  it('reads every value shape OTLP uses', () => {
    const attributes = attributesOf([
      { key: 'aia.alias', value: { stringValue: 'chat-fast' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
      { key: 'score', value: { doubleValue: 0.75 } },
      { key: 'aia.cache_hit', value: { boolValue: true } },
    ]);

    expect(attributes).toEqual({
      'aia.alias': 'chat-fast',
      'gen_ai.usage.input_tokens': '120',
      score: '0.75',
      'aia.cache_hit': 'true',
    });
  });

  it('skips an entry with no key rather than producing an empty one', () => {
    expect(attributesOf([{ value: { stringValue: 'orphan' } }])).toEqual({});
  });

  it('survives no attributes at all', () => {
    expect(attributesOf(undefined)).toEqual({});
  });
});

describe('toSpans', () => {
  it('carries the service name down from the resource', () => {
    const [first] = toSpans(trace('aia-inference-router', [span('POST /v1/chat', 'a')]));

    expect(first?.service).toBe('aia-inference-router');
    expect(first?.name).toBe('POST /v1/chat');
  });

  it('reads the older field name too', () => {
    // Tempo has used both across versions; reading only the current one
    // silently returns an empty trace against an older backend.
    const legacy = {
      batches: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'aia-web' } }] },
          instrumentationLibrarySpans: [{ spans: [span('GET /', 'a')] }],
        },
      ],
    };

    expect(toSpans(legacy)).toHaveLength(1);
  });

  it('computes a duration rather than reporting an end time', () => {
    const [first] = toSpans(trace('svc', [span('call', 'a', { startMs: 5, durationMs: 42 })]));

    expect(first?.durationMs).toBe(42);
  });

  it('never reports a negative duration', () => {
    // Clock skew between two exporters is real, and a negative bar renders as
    // a bar pointing the wrong way.
    const skewed = trace('svc', [
      { spanId: 'a', name: 'call', startTimeUnixNano: nano(100), endTimeUnixNano: nano(50) },
    ]);

    expect(toSpans(skewed)[0]?.durationMs).toBe(0);
  });

  it('reads an error status in both encodings', () => {
    const numeric = toSpans(trace('svc', [span('a', 'a', { error: true })]));
    const named = toSpans({
      batches: [
        { scopeSpans: [{ spans: [{ spanId: 'b', status: { code: 'STATUS_CODE_ERROR' } }] }] },
      ],
    });

    expect(numeric[0]?.status).toBe('error');
    expect(named[0]?.status).toBe('error');
  });

  it('returns nothing for an empty trace instead of throwing', () => {
    expect(toSpans({})).toEqual([]);
  });
});

describe('orderForDisplay', () => {
  const spans = (): SpanView[] =>
    toSpans(
      trace('svc', [
        span('child-b', 'c2', { parent: 'c1', startMs: 20 }),
        span('root', 'c1', { startMs: 0 }),
        span('grandchild', 'c3', { parent: 'c2', startMs: 25 }),
        span('child-a', 'c4', { parent: 'c1', startMs: 10 }),
      ]),
    );

  it('reads as a call stack, depth first and in start order', () => {
    expect(orderForDisplay(spans()).map((s) => s.name)).toEqual([
      'root',
      'child-a',
      'child-b',
      'grandchild',
    ]);
  });

  it('gives each level a depth the view can indent by', () => {
    expect(orderForDisplay(spans()).map((s) => s.depth)).toEqual([0, 1, 1, 2]);
  });

  it('treats an orphan as a root instead of dropping it', () => {
    // A sampled or truncated trace is still worth looking at, and losing the
    // one span that says what went wrong is the wrong trade.
    const orphaned = toSpans(trace('svc', [span('orphan', 'x', { parent: 'not-here' })]));

    expect(orderForDisplay(orphaned).map((s) => s.name)).toEqual(['orphan']);
  });

  it('does not hang on a cycle', () => {
    // Spans come from a backend, and a backend is data: it does not get to
    // hang a server-rendered page.
    const cyclic = toSpans(
      trace('svc', [span('a', 'a', { parent: 'b' }), span('b', 'b', { parent: 'a' })]),
    );

    expect(orderForDisplay(cyclic)).toHaveLength(2);
  });
});

describe('totalDuration', () => {
  it('is wall clock, not the sum of the spans', () => {
    // Adding durations double-counts everything a parent waited on, and a
    // trace with parallel calls comes out longer than the request ever took.
    const spans = toSpans(
      trace('svc', [
        span('root', 'a', { startMs: 0, durationMs: 100 }),
        span('left', 'b', { parent: 'a', startMs: 10, durationMs: 80 }),
        span('right', 'c', { parent: 'a', startMs: 10, durationMs: 80 }),
      ]),
    );

    expect(totalDuration(spans)).toBe(100);
  });

  it('is zero for no spans', () => {
    expect(totalDuration([])).toBe(0);
  });
});

describe('detailOf', () => {
  const full = (): SpanView[] =>
    toSpans(
      trace('aia-inference-router', [
        span('POST /v1/chat/completions', 'a', {
          startMs: 0,
          durationMs: 900,
          attributes: {
            'aia.project_id': 'p1',
            'aia.principal_id': 'u1',
            'aia.alias': 'chat-fast',
          },
        }),
        span('chat gpt-4o-mini', 'b', {
          parent: 'a',
          startMs: 50,
          durationMs: 800,
          attributes: {
            'gen_ai.system': 'openai',
            'gen_ai.request.model': 'gpt-4o-mini',
            'gen_ai.response.model': 'gpt-4o-mini-2024',
            'gen_ai.usage.input_tokens': '120',
            'gen_ai.usage.output_tokens': '48',
            'aia.data_zone': 'us',
          },
        }),
      ]),
    );

  it('rolls the model call up from the CHILD span', () => {
    // The model call is never the root. Reading only the root would leave
    // every gen_ai field blank on a trace that records all of them.
    const detail = detailOf('t1', full());

    expect(detail.model).toEqual({
      provider: 'openai',
      requestModel: 'gpt-4o-mini',
      responseModel: 'gpt-4o-mini-2024',
      inputTokens: 120,
      outputTokens: 48,
    });
  });

  it('picks the platform attributes up wherever they were annotated', () => {
    const detail = detailOf('t1', full());

    expect(detail.projectId).toBe('p1');
    expect(detail.principalId).toBe('u1');
    expect(detail.alias).toBe('chat-fast');
    expect(detail.dataZone).toBe('us');
  });

  it('reports the wall-clock duration', () => {
    expect(detailOf('t1', full()).durationMs).toBe(900);
  });

  it('leaves the model block out when nothing recorded one', () => {
    // A trace with no model call is a trace of something else, not a trace
    // with an empty model panel.
    const detail = detailOf('t1', toSpans(trace('aia-web', [span('GET /', 'a')])));

    expect(detail.model).toBeUndefined();
  });

  it('surfaces an error code the platform annotated', () => {
    const detail = detailOf(
      't1',
      toSpans(
        trace('svc', [span('call', 'a', { attributes: { 'aia.error_code': 'budget_exhausted' } })]),
      ),
    );

    expect(detail.errorCode).toBe('budget_exhausted');
  });
});

describe('escapeTraceQl', () => {
  it('escapes a quote so a value cannot end the string early', () => {
    expect(escapeTraceQl('p1" || true || "')).toBe('p1\\" || true || \\"');
  });

  it('escapes a backslash before it can escape the quote', () => {
    expect(escapeTraceQl('a\\b')).toBe('a\\\\b');
  });

  it('leaves an ordinary project id alone', () => {
    expect(escapeTraceQl('22cf8ecd-dcbf-4772-862a-4eacb7741152')).toBe(
      '22cf8ecd-dcbf-4772-862a-4eacb7741152',
    );
  });
});

/**
 * A trace captured from a real Tempo, not written by hand.
 *
 * A synthetic fixture drifts: it tests what the parser was written against
 * rather than what the backend sends. This one is the response to
 * `GET /api/traces/{id}` for one chat completion, trimmed to the spans that
 * carry something the rollup reads.
 */
describe('a trace as Tempo actually returns it', () => {
  const captured = JSON.parse(
    readFileSync(new URL('./fixtures/tempo-trace.json', import.meta.url), 'utf8'),
  ) as OtlpTrace;

  it('reads every span', () => {
    expect(toSpans(captured).length).toBeGreaterThan(0);
  });

  it('names the services the spans came from', () => {
    const services = new Set(toSpans(captured).map((span) => span.service));

    expect(services.has('aia-inference-router')).toBe(true);
  });

  it('finds the platform attributes the router annotated', () => {
    const detail = detailOf('captured', toSpans(captured));

    expect(detail.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(detail.alias).toBe('chat-local');
    expect(detail.dataZone).toBe('local');
  });

  it('rolls up the model call from its gen_ai attributes', () => {
    const detail = detailOf('captured', toSpans(captured));

    expect(detail.model?.provider).toBe('ollama');
    expect(detail.model?.requestModel).toBeDefined();
    expect(detail.model?.inputTokens).toBeGreaterThan(0);
  });

  it('reports a duration the backend agrees with', () => {
    // Wall clock across the spans, not their sum.
    expect(detailOf('captured', toSpans(captured)).durationMs).toBeGreaterThan(0);
  });
});

describe('framework plumbing', () => {
  const noisy = (): OtlpTrace =>
    trace('aia-mcp-gateway', [
      span('GET /v1/bindings', 'root', { startMs: 0, durationMs: 40 }),
      span('middleware - patched', 'm1', { parent: 'root', startMs: 1, durationMs: 0 }),
      span('middleware - patched', 'm2', { parent: 'root', startMs: 1, durationMs: 0 }),
      span('request handler - /v1/bindings', 'h1', { parent: 'root', startMs: 2, durationMs: 0 }),
      span('find tool_bindings', 'db', { parent: 'root', startMs: 3, durationMs: 30 }),
    ]);

  it('leaves the work and takes out the plumbing', () => {
    const detail = detailOf('t1', toSpans(noisy()));

    expect(detail.spans.map((s) => s.name)).toEqual(['GET /v1/bindings', 'find tool_bindings']);
  });

  it('counts what it hid rather than dropping it silently', () => {
    // A trace viewer that quietly removes spans is lying about the trace.
    expect(detailOf('t1', toSpans(noisy())).hiddenSpans).toBe(3);
  });

  it('keeps a middleware that actually took time', () => {
    // The most interesting span in a slow request is often the middleware that
    // blocked, and it looks exactly like the noise apart from the duration.
    const slow = trace('svc', [
      span('GET /x', 'root', { startMs: 0, durationMs: 500 }),
      span('middleware - patched', 'm1', { parent: 'root', startMs: 1, durationMs: 400 }),
    ]);

    const detail = detailOf('t1', toSpans(slow));

    expect(detail.spans.map((s) => s.name)).toContain('middleware - patched');
    expect(detail.hiddenSpans).toBe(0);
  });

  it('still reads attributes off a span it hid', () => {
    // A hidden span carries attributes too, and losing `aia.project_id`
    // because a middleware was filtered would blank the panel that says whose
    // request this was.
    const hiddenCarrier = trace('svc', [
      span('GET /x', 'root', { startMs: 0, durationMs: 10 }),
      span('middleware - patched', 'm1', {
        parent: 'root',
        durationMs: 0,
        attributes: { 'aia.project_id': 'p1' },
      }),
    ]);

    expect(detailOf('t1', toSpans(hiddenCarrier)).projectId).toBe('p1');
  });

  it('reports the duration the request really took, hidden spans included', () => {
    expect(detailOf('t1', toSpans(noisy())).durationMs).toBe(40);
  });
});

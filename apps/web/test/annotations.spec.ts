import { describe, expect, it } from 'vitest';

import {
  AnnotateTrace,
  ReadAnnotations,
} from '../src/modules/observability/application/use-cases/annotate-trace';
import { HttpEvaluationGateway } from '../src/modules/observability/infrastructure/http/evaluation-gateway';
import { PlatformError } from '../src/modules/console/domain/errors';

const ANNOTATION = {
  id: 'ann-1',
  project_id: 'proj-1',
  trace_id: 'trace-1',
  verdict: 'bad',
  failure_mode: 'invented-a-number',
  note: 'the thirty seconds became five minutes',
  evaluator: 'groundedness',
  principal_id: 'user-ana',
  created_at: '2026-09-09T12:00:00Z',
  is_label: true,
};

function gatewayReturning(
  payload: unknown,
  status = 200,
): { gateway: HttpEvaluationGateway; requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = [];
  const gateway = new HttpEvaluationGateway('http://evaluation', async (url, init) => {
    // `RequestInfo` is a string, a URL or a Request. The gateway passes a
    // string; `toString()` on the union is what the linter objects to, and it
    // is right — a Request would stringify to "[object Object]" and the
    // assertion would pass on nothing.
    requests.push({ url: url instanceof Request ? url.url : url.toString(), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { gateway, requests };
}

describe('reading annotations', () => {
  it('reads the contract shape, taxonomy included', async () => {
    const { gateway } = gatewayReturning({
      items: [ANNOTATION],
      taxonomy: [{ failure_mode: 'invented-a-number', count: 3 }],
    });

    const page = await gateway.listAnnotations('token', 'proj-1', { traceId: 'trace-1' });

    expect(page.items[0]?.failureMode).toBe('invented-a-number');
    expect(page.items[0]?.isLabel).toBe(true);
    expect(page.taxonomy).toEqual([{ failureMode: 'invented-a-number', count: 3 }]);
  });

  it('asks for one trace when it is given one', async () => {
    const { gateway, requests } = gatewayReturning({ items: [], taxonomy: [] });

    await gateway.listAnnotations('token', 'proj-1', { traceId: 'trace-9' });

    expect(requests[0]?.url).toContain('trace_id=trace-9');
  });

  it('a response with no taxonomy is empty rather than undefined', async () => {
    // The console maps over it. An older service that answered without the
    // field would otherwise take the trace view down with it.
    const { gateway } = gatewayReturning({ items: [] });

    await expect(gateway.listAnnotations('token', 'proj-1', {})).resolves.toEqual({
      items: [],
      taxonomy: [],
    });
  });

  it('turns a refusal into a PlatformError rather than an empty page', async () => {
    const { gateway } = gatewayReturning(
      { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden' },
      403,
    );

    await expect(gateway.listAnnotations('token', 'proj-1', {})).rejects.toBeInstanceOf(
      PlatformError,
    );
  });

  it('an unconfigured evaluation service is an empty surface, not an error', async () => {
    // The trace itself is still worth reading. A page that failed to render
    // because nothing could be annotated would be worse than one with no form.
    const useCase = new ReadAnnotations(new HttpEvaluationGateway(''));

    await expect(useCase.execute('token', 'proj-1')).resolves.toEqual({
      items: [],
      taxonomy: [],
    });
  });
});

describe('recording an annotation', () => {
  it('sends what the contract declares, in snake_case', async () => {
    const { gateway, requests } = gatewayReturning(ANNOTATION);

    await new AnnotateTrace(gateway).execute('token', 'proj-1', {
      traceId: 'trace-1',
      verdict: 'bad',
      failureMode: 'Invented a number',
      evaluator: 'groundedness',
      question: 'how long?',
      answer: 'five minutes',
    });

    const sent = requests[0]?.init?.body;
    const body = JSON.parse(typeof sent === 'string' ? sent : '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      trace_id: 'trace-1',
      verdict: 'bad',
      // Sent as the person wrote it. Normalising is the service's job, and
      // doing it here as well would mean two places to change it.
      failure_mode: 'Invented a number',
      evaluator: 'groundedness',
      question: 'how long?',
      answer: 'five minutes',
    });
  });

  it('sends the project as a header, never in the path', async () => {
    const { gateway, requests } = gatewayReturning(ANNOTATION);

    await new AnnotateTrace(gateway).execute('token', 'proj-1', {
      traceId: 'trace-1',
      verdict: 'good',
    });

    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Project-Id']).toBe('proj-1');
    expect(headers.Authorization).toBe('Bearer token');
  });
});

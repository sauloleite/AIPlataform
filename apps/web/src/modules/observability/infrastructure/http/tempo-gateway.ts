import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import type { TraceGateway } from '../../application/ports';
import { nanosToMs, type OtlpTrace, type TraceSummary } from '../../domain/trace';

interface RawTrace {
  traceID?: string;
  rootServiceName?: string;
  rootTraceName?: string;
  startTimeUnixNano?: string;
  durationMs?: number;
}

/**
 * Tempo's query API, inside the LGTM image. Server-side only.
 *
 * The filter is a TraceQL condition on `aia.project_id`, which every span
 * carries. Filtering here rather than after the fact is the same rule as
 * ADR-006's on the vector index: a list narrowed in the console has already
 * been read out of the backend, and a paged read then leaks whatever fell off
 * the end.
 */
export class HttpTempoGateway implements TraceGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  get available(): boolean {
    return this.baseUrl !== '';
  }

  async search(input: {
    projectId: string;
    limit: number;
    sinceMinutes: number;
  }): Promise<TraceSummary[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - input.sinceMinutes * 60;

    // A project id is a uuid from the session, not free text, but it is still
    // interpolated into a query language -- quotes are escaped so a value that
    // ever stops being a uuid cannot change what is asked.
    const query = `{ span.aia.project_id = "${escapeTraceQl(input.projectId)}" }`;
    const url =
      `${this.baseUrl}/api/search?q=${encodeURIComponent(query)}` +
      `&start=${start.toString()}&end=${end.toString()}&limit=${input.limit.toString()}`;

    const body = await this.json<{ traces?: RawTrace[] }>(url);

    return (body.traces ?? [])
      .filter((trace) => trace.traceID !== undefined)
      .map((trace) => ({
        traceId: trace.traceID ?? '',
        rootService: trace.rootServiceName ?? 'unknown',
        rootName: trace.rootTraceName ?? '',
        startedAtMs: nanosToMs(trace.startTimeUnixNano),
        durationMs: trace.durationMs ?? 0,
      }));
  }

  async fetch(traceId: string): Promise<OtlpTrace | null> {
    return this.json<OtlpTrace | null>(
      `${this.baseUrl}/api/traces/${encodeURIComponent(traceId)}`,
      { allowMissing: true },
    );
  }

  private async json<T>(url: string, options: { allowMissing?: boolean } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });

      if (response.status === 404 && options.allowMissing === true) return null as T;
      if (!response.ok) {
        throw new PlatformError({
          type: 'about:blank',
          title: 'The tracing backend did not answer',
          status: response.status,
          code: 'internal_error',
        } satisfies ProblemDetails);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A quote or a backslash would end the string literal early. */
export function escapeTraceQl(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

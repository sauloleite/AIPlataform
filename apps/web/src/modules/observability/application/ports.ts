import type { OtlpTrace, TraceSummary } from '../domain/trace';

/**
 * The tracing backend, as the console needs it.
 *
 * Its own port: a page that lists traces should not depend on an interface
 * that also knows how to approve a tool call.
 */
export interface TraceGateway {
  /** False when no backend is configured. The screen says so rather than erroring. */
  readonly available: boolean;

  search(input: {
    projectId: string;
    limit: number;
    sinceMinutes: number;
  }): Promise<TraceSummary[]>;

  fetch(traceId: string): Promise<OtlpTrace | null>;
}

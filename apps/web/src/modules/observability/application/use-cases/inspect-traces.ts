import { detailOf, toSpans, type TraceDetail, type TraceSummary } from '../../domain/trace';
import type { TraceGateway } from '../ports';

export interface TraceListView {
  traces: TraceSummary[];
  /** False when no tracing backend is configured. */
  available: boolean;
}

export class ListTraces {
  constructor(private readonly traces: TraceGateway) {}

  async execute(
    projectId: string,
    options: { limit?: number; sinceMinutes?: number } = {},
  ): Promise<TraceListView> {
    if (!this.traces.available) return { traces: [], available: false };

    return {
      traces: await this.traces.search({
        projectId,
        limit: options.limit ?? 30,
        sinceMinutes: options.sinceMinutes ?? 60,
      }),
      available: true,
    };
  }
}

export class InspectTrace {
  constructor(private readonly traces: TraceGateway) {}

  async execute(traceId: string): Promise<TraceDetail | null> {
    if (!this.traces.available) return null;

    const raw = await this.traces.fetch(traceId);
    return raw === null ? null : detailOf(traceId, toSpans(raw));
  }
}

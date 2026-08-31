import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import type {
  EvaluationGateway,
  EvaluationMetric,
  EvaluationRunSummary,
  EvaluationStatus,
} from '../../application/evaluation-ports';

interface RawMetric {
  evaluator: string;
  value: number;
  threshold: number | null;
  maximum: number | null;
  passed: boolean;
  sample_size: number;
}

interface RawRun {
  id: string;
  suite: string;
  alias: string;
  status: EvaluationStatus;
  error_code: string | null;
  metrics?: RawMetric[];
  started_at: string;
  finished_at: string | null;
}

/** aia-evaluation over HTTP. Server-side only. */
export class HttpEvaluationGateway implements EvaluationGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  get available(): boolean {
    return this.baseUrl !== '';
  }

  async listRuns(
    accessToken: string,
    projectId: string,
    limit: number,
  ): Promise<EvaluationRunSummary[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/evaluations?limit=${limit.toString()}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Project-Id': projectId,
          },
          cache: 'no-store',
          signal: controller.signal,
        },
      );

      if (!response.ok) throw await problemFrom(response);
      const body = (await response.json()) as { items?: RawRun[] };
      return (body.items ?? []).map(toRun);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toRun(raw: RawRun): EvaluationRunSummary {
  return {
    id: raw.id,
    suite: raw.suite,
    alias: raw.alias,
    status: raw.status,
    errorCode: raw.error_code,
    metrics: (raw.metrics ?? []).map(toMetric),
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
  };
}

function toMetric(raw: RawMetric): EvaluationMetric {
  return {
    evaluator: raw.evaluator,
    value: raw.value,
    threshold: raw.threshold,
    maximum: raw.maximum,
    passed: raw.passed,
    // Zero means nothing was measured, and that has to survive the trip: a
    // metric over no cases must not render as a comfortable zero.
    sampleSize: raw.sample_size,
  };
}

async function problemFrom(response: Response): Promise<PlatformError> {
  try {
    return new PlatformError((await response.json()) as ProblemDetails);
  } catch {
    return new PlatformError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: 'internal_error',
    });
  }
}

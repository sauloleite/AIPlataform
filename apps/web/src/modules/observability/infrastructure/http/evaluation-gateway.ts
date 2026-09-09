import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import type {
  Annotation,
  AnnotationDraft,
  AnnotationPage,
  AnnotationVerdict,
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

  async listAnnotations(
    accessToken: string,
    projectId: string,
    options: { traceId?: string; limit?: number },
  ): Promise<AnnotationPage> {
    const query = new URLSearchParams({ limit: (options.limit ?? 25).toString() });
    if (options.traceId !== undefined) query.set('trace_id', options.traceId);

    const body = await this.call<{ items?: RawAnnotation[]; taxonomy?: RawFailureMode[] }>(
      `/v1/annotations?${query.toString()}`,
      accessToken,
      projectId,
    );

    return {
      items: (body.items ?? []).map(toAnnotation),
      taxonomy: (body.taxonomy ?? []).map((raw) => ({
        failureMode: raw.failure_mode,
        count: raw.count,
      })),
    };
  }

  async recordAnnotation(
    accessToken: string,
    projectId: string,
    draft: AnnotationDraft,
  ): Promise<Annotation> {
    const raw = await this.call<RawAnnotation>('/v1/annotations', accessToken, projectId, {
      method: 'POST',
      body: JSON.stringify({
        trace_id: draft.traceId,
        verdict: draft.verdict,
        failure_mode: draft.failureMode ?? '',
        note: draft.note ?? '',
        evaluator: draft.evaluator ?? '',
        question: draft.question ?? '',
        answer: draft.answer ?? '',
        context: draft.context ?? [],
      }),
    });
    return toAnnotation(raw);
  }

  /**
   * One request, with the timeout the whole class uses.
   *
   * Extracted when the third caller appeared: the abort controller and its
   * `clearTimeout` are the kind of thing that gets copied with the timer left
   * running, and a leaked timer in a server component holds the request open.
   */
  private async call<T>(
    path: string,
    accessToken: string,
    projectId: string,
    init: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Project-Id': projectId,
        },
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) throw await problemFrom(response);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RawAnnotation {
  id: string;
  trace_id: string;
  verdict: AnnotationVerdict;
  failure_mode: string | null;
  note: string | null;
  evaluator: string | null;
  principal_id: string;
  created_at: string;
  is_label?: boolean;
}

interface RawFailureMode {
  failure_mode: string;
  count: number;
}

function toAnnotation(raw: RawAnnotation): Annotation {
  return {
    id: raw.id,
    traceId: raw.trace_id,
    verdict: raw.verdict,
    failureMode: raw.failure_mode,
    note: raw.note,
    evaluator: raw.evaluator,
    principalId: raw.principal_id,
    createdAt: raw.created_at,
    isLabel: raw.is_label ?? false,
  };
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

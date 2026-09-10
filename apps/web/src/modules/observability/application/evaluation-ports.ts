/** The console's view of aia-evaluation. */

export type EvaluationStatus = 'running' | 'passed' | 'failed' | 'errored';

export interface EvaluationMetric {
  evaluator: string;
  value: number;
  threshold: number | null;
  maximum: number | null;
  passed: boolean;
  sampleSize: number;
}

export interface EvaluationRunSummary {
  id: string;
  suite: string;
  alias: string;
  status: EvaluationStatus;
  errorCode: string | null;
  metrics: EvaluationMetric[];
  startedAt: string;
  finishedAt: string | null;
}

export interface EvaluationGateway {
  /** False when no evaluation service is configured. */
  readonly available: boolean;

  listRuns(accessToken: string, projectId: string, limit: number): Promise<EvaluationRunSummary[]>;

  listAnnotations(
    accessToken: string,
    projectId: string,
    options: { traceId?: string; limit?: number },
  ): Promise<AnnotationPage>;

  recordAnnotation(
    accessToken: string,
    projectId: string,
    draft: AnnotationDraft,
  ): Promise<Annotation>;
}

/**
 * What a person decided about one trace.
 *
 * The console is where error analysis actually happens: somebody reads a real
 * trace, decides the answer was wrong, and says how. Nothing else in the
 * platform can capture that, and an evaluator written without it measures what
 * its author imagined.
 */
export type AnnotationVerdict = 'good' | 'bad';

export interface Annotation {
  id: string;
  traceId: string;
  verdict: AnnotationVerdict;
  failureMode: string | null;
  note: string | null;
  evaluator: string | null;
  principalId: string;
  createdAt: string;
  /** Whether it can calibrate a judge: it needs an evaluator and the text. */
  isLabel: boolean;
}

export interface FailureModeCount {
  failureMode: string;
  count: number;
}

export interface AnnotationDraft {
  traceId: string;
  verdict: AnnotationVerdict;
  failureMode?: string;
  note?: string;
  evaluator?: string;
  question?: string;
  answer?: string;
  context?: string[];
}

export interface AnnotationPage {
  items: Annotation[];
  /** Every failure mode this project has recorded, commonest first. */
  taxonomy: FailureModeCount[];
}

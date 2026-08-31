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
}

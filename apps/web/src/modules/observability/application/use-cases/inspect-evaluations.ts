import type { EvaluationGateway, EvaluationRunSummary } from '../evaluation-ports';

export interface EvaluationsView {
  runs: EvaluationRunSummary[];
  available: boolean;
  /** Runs that would stop a merge. Both kinds, because both do. */
  gated: number;
}

/**
 * Two kinds of bad run, kept apart.
 *
 * `failed` is quality below a threshold — look at the prompts. `errored` is a
 * measurement that did not happen — look at the wiring. Counting them together
 * as "red" sends half the people to the wrong place.
 */
export function summarise(runs: EvaluationRunSummary[]): EvaluationsView {
  return {
    runs,
    available: true,
    gated: runs.filter((run) => run.status === 'failed' || run.status === 'errored').length,
  };
}

export class ListEvaluations {
  constructor(private readonly evaluations: EvaluationGateway) {}

  async execute(accessToken: string, projectId: string, limit = 25): Promise<EvaluationsView> {
    if (!this.evaluations.available) return { runs: [], available: false, gated: 0 };

    return summarise(await this.evaluations.listRuns(accessToken, projectId, limit));
  }
}

import { describe, expect, it } from 'vitest';

import { summarise } from '../src/modules/observability/application/use-cases/inspect-evaluations';
import { HttpEvaluationGateway } from '../src/modules/observability/infrastructure/http/evaluation-gateway';
import type { EvaluationRunSummary } from '../src/modules/observability/application/evaluation-ports';

function aRun(overrides: Partial<EvaluationRunSummary> = {}): EvaluationRunSummary {
  return {
    id: 'r1',
    suite: 'platform-runbook',
    alias: 'chat-local',
    status: 'passed',
    errorCode: null,
    metrics: [],
    startedAt: '2026-08-29T12:00:00Z',
    finishedAt: '2026-08-29T12:01:00Z',
    ...overrides,
  };
}

describe('summarising evaluation runs', () => {
  it('counts both kinds of bad run as gating', () => {
    // `failed` is quality below a threshold and `errored` is a measurement that
    // did not happen. They are different problems, and both stop a merge.
    const view = summarise([
      aRun(),
      aRun({ id: 'r2', status: 'failed' }),
      aRun({ id: 'r3', status: 'errored', errorCode: 'validation_failed' }),
      aRun({ id: 'r4', status: 'running' }),
    ]);

    expect(view.gated).toBe(2);
  });

  it('counts none when everything passed', () => {
    expect(summarise([aRun()]).gated).toBe(0);
  });
});

describe('the evaluation adapter reads the contract shape', () => {
  function gatewayReturning(payload: unknown): HttpEvaluationGateway {
    return new HttpEvaluationGateway(
      'http://evaluation',
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  }

  it('maps a run and its metrics', async () => {
    const gateway = gatewayReturning({
      items: [
        {
          id: 'r1',
          project_id: 'p1',
          suite: 'platform-runbook',
          alias: 'chat-local',
          status: 'failed',
          error_code: null,
          started_at: '2026-08-29T12:00:00Z',
          finished_at: '2026-08-29T12:01:00Z',
          metrics: [
            {
              evaluator: 'groundedness',
              value: 0.42,
              threshold: 0.6,
              maximum: null,
              passed: false,
              sample_size: 6,
            },
          ],
        },
      ],
    });

    const [run] = await gateway.listRuns('token', 'p1', 25);

    expect(run?.status).toBe('failed');
    expect(run?.metrics[0]?.threshold).toBe(0.6);
    expect(run?.metrics[0]?.passed).toBe(false);
    expect(run?.metrics[0]?.sampleSize).toBe(6);
  });

  it('carries a sample size of zero through rather than losing it', async () => {
    // Zero means nothing was measured. Read under the wrong key it becomes
    // `undefined`, and the screen shows a blank where the warning belongs.
    const gateway = gatewayReturning({
      items: [
        {
          id: 'r1',
          suite: 's',
          alias: 'a',
          status: 'errored',
          error_code: 'validation_failed',
          started_at: '2026-08-29T12:00:00Z',
          finished_at: null,
          metrics: [
            {
              evaluator: 'groundedness',
              value: 0,
              threshold: 0.6,
              maximum: null,
              passed: false,
              sample_size: 0,
            },
          ],
        },
      ],
    });

    const [run] = await gateway.listRuns('token', 'p1', 25);

    expect(run?.metrics[0]?.sampleSize).toBe(0);
    expect(run?.errorCode).toBe('validation_failed');
  });

  it('survives a run with no metrics at all', async () => {
    const gateway = gatewayReturning({
      items: [
        {
          id: 'r1',
          suite: 's',
          alias: 'a',
          status: 'errored',
          error_code: 'not_found',
          started_at: '2026-08-29T12:00:00Z',
          finished_at: null,
        },
      ],
    });

    const [run] = await gateway.listRuns('token', 'p1', 25);

    expect(run?.metrics).toEqual([]);
  });

  it('reports itself unavailable with no service configured', () => {
    expect(new HttpEvaluationGateway('').available).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type ErrorCode } from './catalog.js';
import { DomainError, InternalError, NotFoundError } from './domain-error.js';
import { fromUnknown, titleFor, toProblemDetails } from './problem-details.js';

class BudgetExhausted extends DomainError {
  readonly code = ERROR_CODES.BUDGET_EXHAUSTED;
  readonly status = 429;
  constructor(projectId: string, retryAfter: number) {
    super(`Budget exhausted for project ${projectId}`, {
      project_id: projectId,
      retry_after: retryAfter,
    });
  }
}

describe('toProblemDetails', () => {
  it('includes type, title, status, code and the error extensions', () => {
    const problem = toProblemDetails(new BudgetExhausted('proj-1', 60), {
      instance: '/v1/chat/completions',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });

    expect(problem).toMatchObject({
      type: 'https://aia.dev/errors/budget_exhausted',
      title: 'Project budget exhausted',
      status: 429,
      code: 'budget_exhausted',
      instance: '/v1/chat/completions',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      project_id: 'proj-1',
      retry_after: 60,
    });
  });

  it('omits instance and trace_id when no context is given', () => {
    const problem = toProblemDetails(new NotFoundError('Project', 'proj-9'));

    expect(problem.instance).toBeUndefined();
    expect(problem.trace_id).toBeUndefined();
    expect(problem.status).toBe(404);
  });
});

describe('fromUnknown', () => {
  it('does not leak the message of an unknown error', () => {
    const problem = fromUnknown(new Error('connection refused at mongo://internal:27017'));

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('internal_error');
    expect(problem.detail).toBe('Internal error');
    expect(JSON.stringify(problem)).not.toContain('mongo://');
  });

  it('preserves the domain error when there is one', () => {
    expect(fromUnknown(new InternalError('failed', { step: 'commit' }))).toMatchObject({
      code: 'internal_error',
      step: 'commit',
    });
  });

  it('handles thrown values that are not even Errors', () => {
    expect(fromUnknown('a bare string').status).toBe(500);
  });
});

describe('the title catalogue', () => {
  /**
   * The whole catalogue, not a sample.
   *
   * `titleFor` falls back to 'Error' for an unknown code, which is right for a
   * code from a newer version and wrong for one this package declares. Fourteen
   * of the thirty-seven had drifted into that fallback -- every error registry,
   * knowledge, mcp-gateway and agent-runtime raise, because those services
   * shipped after the map was last touched. The failure was invisible: the
   * response was still valid Problem Details, just titled "Error".
   */
  it('gives every declared code a title of its own', () => {
    const untitled = Object.values(ERROR_CODES).filter((code) => titleFor(code) === 'Error');

    expect(untitled).toEqual([]);
  });

  it('still falls back for a code it has never heard of', () => {
    expect(titleFor('from_a_newer_version' as ErrorCode)).toBe('Error');
  });
});

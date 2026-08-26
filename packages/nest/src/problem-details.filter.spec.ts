import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '@aia/errors';
import { ProblemDetailsFilter } from './problem-details.filter.js';

/** Fake response and request exposing the surface the filter uses. */
function hostFor(url = '/v1/chat/completions'): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const type = vi.fn(() => ({ send }));
  const status = vi.fn(() => ({ type, send }));
  const setHeader = vi.fn();

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, type, send, setHeader }),
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, type, send, setHeader };
}

function bodyOf(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return send.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('ProblemDetailsFilter', () => {
  it('translates a domain error preserving status and stable code', () => {
    const { host, status, type, send } = hostFor();
    new ProblemDetailsFilter().catch(new NotFoundError('Project', 'proj-1'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(bodyOf(send)).toMatchObject({
      type: 'https://aia.dev/errors/not_found',
      status: 404,
      code: 'not_found',
      resource: 'Project',
      id: 'proj-1',
      instance: '/v1/chat/completions',
    });
  });

  it('carries the error details as Problem Details extensions', () => {
    const { host, send } = hostFor();
    new ProblemDetailsFilter().catch(
      new ForbiddenError('not permitted', { rule: 'project_owner', project_id: 'proj-1' }),
      host,
    );

    expect(bodyOf(send)).toMatchObject({ code: 'forbidden', rule: 'project_owner' });
  });

  it('sets Retry-After when the error says when to retry', () => {
    const { host, setHeader, send } = hostFor();
    new ProblemDetailsFilter().catch(new ValidationError('wait', { retry_after: 42 }), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(bodyOf(send)['retry_after']).toBe(42);
  });

  it('does NOT leak the internal message of an unknown error', () => {
    const { host, status, send } = hostFor();
    new ProblemDetailsFilter().catch(
      new Error('connection refused at mongodb://internal:27017'),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
    const body = bodyOf(send);
    expect(body['detail']).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('mongodb://');
  });

  it('maps a framework exception without losing the status', () => {
    const { host, status, send } = hostFor();
    new ProblemDetailsFilter().catch(
      new HttpException('invalid body', HttpStatus.BAD_REQUEST),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(bodyOf(send)['code']).toBe('validation_failed');
  });

  it('handles a thrown value that is not even an Error', () => {
    const { host, status } = hostFor();
    expect(() => {
      new ProblemDetailsFilter().catch('a bare string', host);
    }).not.toThrow();
    expect(status).toHaveBeenCalledWith(500);
  });
});

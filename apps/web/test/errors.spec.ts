import { describe, expect, it } from 'vitest';
import {
  PlatformError,
  isPlatformError,
  messageFor,
  requiresSignIn,
} from '../src/modules/console/domain/errors';

function problem(code: string, detail?: string): PlatformError {
  return new PlatformError({
    type: `https://aia.dev/errors/${code}`,
    title: code,
    status: 400,
    code,
    ...(detail !== undefined && { detail }),
  });
}

describe('platform errors', () => {
  it('explains a stable code in words a user can act on', () => {
    expect(messageFor(problem('budget_exhausted'))).toMatch(/used up its budget/);
    expect(messageFor(problem('no_compatible_deployment'))).toMatch(/data classification/);
  });

  it('falls back to the platform detail for a code it does not know', () => {
    // A code the console has not seen still has to say something useful, and the
    // platform's own detail is already safe to show.
    expect(messageFor(problem('brand_new_code', 'The new thing failed.'))).toBe(
      'The new thing failed.',
    );
  });

  it('keys sign-out off the code, never off the message', () => {
    expect(requiresSignIn(problem('token_expired'))).toBe(true);
    expect(requiresSignIn(problem('invalid_token'))).toBe(true);
    expect(requiresSignIn(problem('unauthenticated'))).toBe(true);
    expect(requiresSignIn(problem('forbidden'))).toBe(false);
    expect(requiresSignIn(new Error('unauthenticated'))).toBe(false);
  });

  it('handles something thrown that is not a platform error at all', () => {
    expect(messageFor(new Error('boom'))).toBe('boom');
    expect(messageFor('a bare string')).toBe('Something went wrong.');
    expect(isPlatformError('a bare string')).toBe(false);
  });

  it('exposes retry_after so the UI can say when to try again', () => {
    const error = new PlatformError({
      type: 'https://aia.dev/errors/budget_exhausted',
      title: 'Project budget exhausted',
      status: 429,
      code: 'budget_exhausted',
      retry_after: 60,
    });

    expect(error.retryAfterSeconds).toBe(60);
    expect(error.status).toBe(429);
  });
});

describe('messageFor, on a validation error', () => {
  it('prefers the server detail, which names the field', () => {
    // "The request is invalid" leaves the user guessing which of six inputs was
    // wrong. The platform already said.
    const error = new PlatformError({
      type: 'https://aia.dev/errors/validation_failed',
      title: 'Invalid request',
      status: 400,
      code: 'validation_failed',
      detail: 'Unknown data classification',
    });

    expect(messageFor(error)).toBe('Unknown data classification');
  });

  it('still falls back to our phrasing when the server sent no detail', () => {
    expect(messageFor(problem('validation_failed'))).toBe('The request is invalid.');
  });

  it('keeps our phrasing where it beats the server detail', () => {
    // "Budget exhausted for project proj-1" is accurate and useless.
    const error = new PlatformError({
      type: 'https://aia.dev/errors/budget_exhausted',
      title: 'Project budget exhausted',
      status: 429,
      code: 'budget_exhausted',
      detail: 'Budget exhausted for project proj-1',
    });

    expect(messageFor(error)).toMatch(/used up its budget/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { isRetryable, nextDelayMs, withRetry } from './retry.js';
import type { RetryPolicy } from './types.js';

const POLICY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 5_000 };

describe('isRetryable', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries on %i', (status) => {
    expect(isRetryable({ status }, POLICY)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry on %i', (status) => {
    expect(isRetryable({ status }, POLICY)).toBe(false);
  });

  it('retries an error with no status, which means a network failure', () => {
    expect(isRetryable(new Error('ECONNRESET'), POLICY)).toBe(true);
  });
});

describe('nextDelayMs', () => {
  it('honours the dependency Retry-After instead of the backoff', () => {
    expect(nextDelayMs(0, POLICY, { status: 429, retryAfterMs: 3_000 }, () => 0.5)).toBe(3_000);
  });

  it('caps Retry-After at the policy ceiling', () => {
    expect(nextDelayMs(0, POLICY, { status: 429, retryAfterMs: 99_000 }, () => 1)).toBe(5_000);
  });

  it('ignores Retry-After when the policy says to', () => {
    const policy = { ...POLICY, honorRetryAfter: false };
    expect(nextDelayMs(0, policy, { retryAfterMs: 3_000 }, () => 1)).toBe(100);
  });

  it('grows exponentially and applies jitter', () => {
    expect(nextDelayMs(0, POLICY, {}, () => 1)).toBe(100);
    expect(nextDelayMs(1, POLICY, {}, () => 1)).toBe(200);
    expect(nextDelayMs(2, POLICY, {}, () => 1)).toBe(400);
    // full jitter: o valor sorteado fica entre 0 e o teto exponencial
    expect(nextDelayMs(2, POLICY, {}, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  const noSleep = { sleep: async (): Promise<void> => Promise.resolve() };

  it('returns the result of the first successful attempt', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, POLICY, {}, noSleep)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('performs maxAttempts ADDITIONAL retries', async () => {
    const operation = vi.fn().mockRejectedValue({ status: 503 });
    await expect(withRetry(operation, POLICY, {}, noSleep)).rejects.toMatchObject({ status: 503 });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable error and fails on the first attempt', async () => {
    const operation = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(operation, POLICY, {}, noSleep)).rejects.toMatchObject({ status: 400 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as an attempt succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('recuperado');
    await expect(withRetry(operation, POLICY, {}, noSleep)).resolves.toBe('recuperado');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('notifies the caller of each retry, for metrics', async () => {
    const onRetry = vi.fn();
    const operation = vi.fn().mockRejectedValueOnce({ status: 500 }).mockResolvedValue('ok');
    await withRetry(operation, POLICY, {}, { ...noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });
});

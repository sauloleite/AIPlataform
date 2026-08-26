import { describe, expect, it, vi } from 'vitest';
import { isRetryable, nextDelayMs, withRetry } from './retry.js';
import type { RetryPolicy } from './types.js';

const POLICY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 5_000 };

describe('isRetryable', () => {
  it.each([408, 429, 500, 502, 503, 504])('retenta em %i', (status) => {
    expect(isRetryable({ status }, POLICY)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('nao retenta em %i', (status) => {
    expect(isRetryable({ status }, POLICY)).toBe(false);
  });

  it('retenta erro sem status, que e falha de rede', () => {
    expect(isRetryable(new Error('ECONNRESET'), POLICY)).toBe(true);
  });
});

describe('nextDelayMs', () => {
  it('respeita o Retry-After da dependencia em vez do backoff', () => {
    expect(nextDelayMs(0, POLICY, { status: 429, retryAfterMs: 3_000 }, () => 0.5)).toBe(3_000);
  });

  it('limita o Retry-After ao teto da politica', () => {
    expect(nextDelayMs(0, POLICY, { status: 429, retryAfterMs: 99_000 }, () => 1)).toBe(5_000);
  });

  it('ignora o Retry-After quando a politica manda ignorar', () => {
    const policy = { ...POLICY, honorRetryAfter: false };
    expect(nextDelayMs(0, policy, { retryAfterMs: 3_000 }, () => 1)).toBe(100);
  });

  it('cresce exponencialmente e aplica jitter', () => {
    expect(nextDelayMs(0, POLICY, {}, () => 1)).toBe(100);
    expect(nextDelayMs(1, POLICY, {}, () => 1)).toBe(200);
    expect(nextDelayMs(2, POLICY, {}, () => 1)).toBe(400);
    // full jitter: o valor sorteado fica entre 0 e o teto exponencial
    expect(nextDelayMs(2, POLICY, {}, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  const noSleep = { sleep: async (): Promise<void> => Promise.resolve() };

  it('devolve o resultado da primeira tentativa bem sucedida', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, POLICY, {}, noSleep)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('faz maxAttempts retentativas ADICIONAIS', async () => {
    const operation = vi.fn().mockRejectedValue({ status: 503 });
    await expect(withRetry(operation, POLICY, {}, noSleep)).rejects.toMatchObject({ status: 503 });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('nao retenta erro nao retentavel e falha na primeira', async () => {
    const operation = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(operation, POLICY, {}, noSleep)).rejects.toMatchObject({ status: 400 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('para assim que uma tentativa tem sucesso', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('recuperado');
    await expect(withRetry(operation, POLICY, {}, noSleep)).resolves.toBe('recuperado');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('avisa o chamador de cada retentativa, para a metrica', async () => {
    const onRetry = vi.fn();
    const operation = vi.fn().mockRejectedValueOnce({ status: 500 }).mockResolvedValue('ok');
    await withRetry(operation, POLICY, {}, { ...noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });
});

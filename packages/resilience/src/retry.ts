import { DEFAULT_RETRYABLE_STATUSES, type RetryPolicy, type TransportErrorLike } from './types.js';

/** Le status e Retry-After de um erro sem assumir a biblioteca HTTP usada. */
export function asTransportError(error: unknown): TransportErrorLike {
  if (typeof error !== 'object' || error === null) return {};
  const candidate = error as Record<string, unknown>;
  const status = typeof candidate['status'] === 'number' ? candidate['status'] : undefined;
  const retryAfterMs =
    typeof candidate['retryAfterMs'] === 'number' ? candidate['retryAfterMs'] : undefined;
  return {
    ...(status !== undefined && { status }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

export function isRetryable(error: unknown, policy: RetryPolicy): boolean {
  const { status } = asTransportError(error);
  // Sem status: falha de rede (ECONNRESET, DNS, socket). Vale tentar de novo.
  if (status === undefined) return true;
  const retryable = policy.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
  return retryable.includes(status);
}

/**
 * Backoff exponencial com full jitter.
 *
 * O jitter existe para nao sincronizar as retentativas de todos os clientes
 * apos uma indisponibilidade (thundering herd).
 */
export function nextDelayMs(
  attempt: number,
  policy: RetryPolicy,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (policy.honorRetryAfter !== false) {
    const { retryAfterMs } = asTransportError(error);
    // A dependencia sabe melhor que nos quando estara pronta.
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return Math.min(retryAfterMs, policy.maxDelayMs);
    }
  }
  const exponential = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.floor(random() * exponential);
}

export interface RetryHooks {
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Executa `operation` repetindo apenas o que a politica considera retentavel. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  context: { signal?: AbortSignal } = {},
  hooks: RetryHooks = {},
): Promise<T> {
  const doSleep = hooks.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const exhausted = attempt === policy.maxAttempts;
      if (exhausted || !isRetryable(error, policy)) throw error;

      const delayMs = nextDelayMs(attempt, policy, error, hooks.random);
      hooks.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await doSleep(delayMs, context.signal);
    }
  }

  throw lastError;
}

import { DEFAULT_RETRYABLE_STATUSES, type RetryPolicy, type TransportErrorLike } from './types.js';

/** Reads status and Retry-After from an error without assuming an HTTP library. */
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
  // No status means a network failure (ECONNRESET, DNS, socket). Worth retrying.
  if (status === undefined) return true;
  const retryable = policy.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
  return retryable.includes(status);
}

/**
 * Exponential backoff with full jitter.
 *
 * The jitter exists so that every client does not retry in lockstep after an
 * outage (thundering herd).
 */
export function nextDelayMs(
  attempt: number,
  policy: RetryPolicy,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (policy.honorRetryAfter !== false) {
    const { retryAfterMs } = asTransportError(error);
    // The dependency knows better than we do when it will be ready.
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

/** Runs `operation`, retrying only what the policy considers retryable. */
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

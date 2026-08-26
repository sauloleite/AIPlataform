/**
 * Declared resilience policies (reference doc 02 §8).
 *
 * They live here, not in each service, so that nobody reinvents retry.
 */

/** A transport error carrying enough information to decide about retrying. */
export interface TransportErrorLike {
  /** HTTP status returned by the dependency, when there was a response. */
  status?: number;
  /** The `Retry-After` header, already converted to milliseconds. */
  retryAfterMs?: number;
}

export interface TimeoutPolicy {
  /** Maximum time to establish the connection. */
  connectMs?: number;
  /** Maximum total time for the operation. */
  totalMs: number;
}

export interface RetryPolicy {
  /** Number of ADDITIONAL attempts. `maxAttempts: 2` means up to 3 calls. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Statuses worth retrying. Defaults to 408, 429 and 5xx. */
  retryableStatuses?: readonly number[];
  /** When `false`, ignores the dependency's `Retry-After`. Defaults to `true`. */
  honorRetryAfter?: boolean;
}

export interface CircuitBreakerPolicy {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before probing again. */
  openMs: number;
  /** Successes in half-open needed to close it. */
  successThreshold: number;
}

export interface BulkheadPolicy {
  /** Concurrent calls allowed per key, normally the project. */
  maxConcurrent: number;
  /** Maximum wait for a slot before rejecting. */
  acquireTimeoutMs: number;
  /** Slot lifetime, so a dead process cannot wedge the semaphore. */
  leaseTtlMs?: number;
}

export interface ResiliencePolicy {
  /** Name used in metrics, logs and as the circuit key. */
  name: string;
  timeout?: TimeoutPolicy;
  retry?: RetryPolicy;
  circuitBreaker?: CircuitBreakerPolicy;
  bulkhead?: BulkheadPolicy;
}

/** Context for one protected execution. */
export interface ExecutionContext {
  /** Discriminates circuit and semaphore. E.g. `openai:gpt-4o-mini`, or a project id. */
  key?: string;
  signal?: AbortSignal;
}

export const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504] as const;

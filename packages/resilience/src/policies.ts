import type { ResiliencePolicy } from './types.js';

/**
 * Named policies from the table in reference doc 02 §8.
 *
 * A service picks a policy by the KIND of call it is making; it never invents
 * numbers. Changing a value here changes behaviour across the whole platform,
 * which is the point.
 */
export const POLICIES = {
  /** Non-streaming inference: 3 s to connect, 60 s total, up to 2 retries. */
  INFERENCE: {
    name: 'inference',
    timeout: { connectMs: 3_000, totalMs: 60_000 },
    retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 8_000, honorRetryAfter: true },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
    bulkhead: { maxConcurrent: 20, acquireTimeoutMs: 2_000, leaseTtlMs: 90_000 },
  },

  /**
   * Streaming inference: 10 s to the first token, 30 s of inactivity.
   * There is no retry after the first token; the failure becomes
   * `stream_interrupted`.
   */
  INFERENCE_STREAMING: {
    name: 'inference_streaming',
    timeout: { connectMs: 3_000, totalMs: 10_000 },
    retry: { maxAttempts: 1, baseDelayMs: 300, maxDelayMs: 3_000, honorRetryAfter: true },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
    bulkhead: { maxConcurrent: 20, acquireTimeoutMs: 2_000, leaseTtlMs: 300_000 },
  },

  /**
   * Streaming inference against a LOCAL model.
   *
   * The 10 s time-to-first-token budget suits a cloud provider, which already
   * has the model resident. A local model has to read it from disk on the first
   * call, and failing for that reason would break precisely the zero-cost path.
   * After the first token the rule is the same: no retry.
   */
  INFERENCE_STREAMING_LOCAL: {
    name: 'inference_streaming_local',
    timeout: { connectMs: 2_000, totalMs: 120_000 },
    retry: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  },

  /** Non-streaming inference against a local model: same reason, larger budget. */
  INFERENCE_LOCAL: {
    name: 'inference_local',
    timeout: { connectMs: 2_000, totalMs: 180_000 },
    retry: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 2_000 },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  },

  /** Batched embeddings: 30 s per batch, up to 3 retries. */
  EMBEDDINGS: {
    name: 'embeddings',
    timeout: { connectMs: 3_000, totalMs: 30_000 },
    retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000, honorRetryAfter: true },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  },

  /**
   * Internal call (governance, registry): 2 s and one retry.
   * The fallback is the caller's local cache with a TTL.
   */
  INTERNAL: {
    name: 'internal',
    timeout: { connectMs: 1_000, totalMs: 2_000 },
    retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500 },
    circuitBreaker: { failureThreshold: 5, openMs: 10_000, successThreshold: 2 },
  },

  /**
   * Tool call over MCP: no automatic retry, because the action may not be
   * idempotent (reference doc 02 §8). The error goes back to the agent as an
   * observation.
   */
  TOOL: {
    name: 'tool',
    timeout: { connectMs: 2_000, totalMs: 20_000 },
    circuitBreaker: { failureThreshold: 3, openMs: 60_000, successThreshold: 1 },
    bulkhead: { maxConcurrent: 5, acquireTimeoutMs: 1_000, leaseTtlMs: 30_000 },
  },

  /** Guardrails: fast and mandatory; failing open would be a security risk. */
  GUARDRAIL: {
    name: 'guardrail',
    timeout: { connectMs: 500, totalMs: 3_000 },
    retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 400 },
    circuitBreaker: { failureThreshold: 10, openMs: 15_000, successThreshold: 3 },
  },
} as const satisfies Record<string, ResiliencePolicy>;

export type PolicyName = keyof typeof POLICIES;

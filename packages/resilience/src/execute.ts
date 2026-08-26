import { CircuitBreaker } from './circuit-breaker.js';
import { withRetry } from './retry.js';
import { withTimeout } from './timeout.js';
import type { Bulkhead } from './bulkhead.js';
import type { ExecutionContext, ResiliencePolicy } from './types.js';

export interface ResilienceHooks {
  onRetry?: (info: { policy: string; attempt: number; delayMs: number; error: unknown }) => void;
  onCircuitStateChange?: (info: { key: string; from: string; to: string }) => void;
}

/**
 * Wraps an operation in the declared policy.
 *
 * Layer order, outermost first:
 *   bulkhead -> retry -> circuit breaker -> timeout -> operation
 *
 * The bulkhead sits outside because it caps how many executions exist at once,
 * retries included. The circuit breaker sits inside the retry so that each
 * attempt reads current state and a failing attempt is counted immediately.
 */
export class ResilienceExecutor {
  private readonly breaker?: CircuitBreaker;
  private readonly hooks: ResilienceHooks;

  constructor(
    private readonly policy: ResiliencePolicy,
    private readonly dependencies: { bulkhead?: Bulkhead } = {},
    hooks: ResilienceHooks = {},
  ) {
    this.hooks = hooks;
    if (policy.circuitBreaker !== undefined) {
      this.breaker = new CircuitBreaker(policy.circuitBreaker, {
        ...(hooks.onCircuitStateChange !== undefined && {
          onStateChange: hooks.onCircuitStateChange,
        }),
      });
    }
  }

  circuitState(key: string): string | undefined {
    return this.breaker?.stateOf(key);
  }

  async execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    context: ExecutionContext = {},
  ): Promise<T> {
    const key = context.key ?? this.policy.name;
    const bulkhead = this.dependencies.bulkhead;
    const lease =
      this.policy.bulkhead !== undefined && bulkhead !== undefined
        ? await bulkhead.acquire(key)
        : undefined;

    try {
      const guarded = async (): Promise<T> => {
        const timed = async (): Promise<T> => {
          if (this.policy.timeout === undefined) {
            return operation(context.signal ?? new AbortController().signal);
          }
          return withTimeout(operation, this.policy.timeout.totalMs, key, context.signal);
        };
        return this.breaker === undefined ? timed() : this.breaker.execute(key, timed);
      };

      if (this.policy.retry === undefined) return await guarded();

      return await withRetry(
        guarded,
        this.policy.retry,
        { ...(context.signal !== undefined && { signal: context.signal }) },
        {
          onRetry: ({ attempt, delayMs, error }) =>
            this.hooks.onRetry?.({ policy: this.policy.name, attempt, delayMs, error }),
        },
      );
    } finally {
      await lease?.release();
    }
  }
}

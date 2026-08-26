import { CircuitOpenError } from '@aia/errors';
import { asTransportError } from './retry.js';
import type { CircuitBreakerPolicy } from './types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  opensUntil: number;
}

export interface CircuitBreakerHooks {
  onStateChange?: (info: { key: string; from: CircuitState; to: CircuitState }) => void;
  now?: () => number;
}

/**
 * Circuit breaker per key, in memory and per process.
 *
 * Each replica learns on its own that a deployment is unhealthy. Sharing state
 * between replicas would mean a network round trip on the critical path of every
 * inference, which costs more than it saves (reference doc 02 §8).
 *
 * When the dependency returns `Retry-After`, that value decides how long the
 * circuit stays open: the duration comes from the side that knows.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitEntry>();
  private readonly now: () => number;

  constructor(
    private readonly policy: CircuitBreakerPolicy,
    private readonly hooks: CircuitBreakerHooks = {},
  ) {
    this.now = hooks.now ?? Date.now;
  }

  stateOf(key: string): CircuitState {
    return this.entry(key).state;
  }

  /** Throws `CircuitOpenError` if the key is currently blocked. */
  ensureClosed(key: string): void {
    const entry = this.entry(key);
    if (entry.state !== 'open') return;

    const remaining = entry.opensUntil - this.now();
    if (remaining > 0) throw new CircuitOpenError(key, remaining);

    this.transition(key, entry, 'half-open');
  }

  recordSuccess(key: string): void {
    const entry = this.entry(key);
    entry.consecutiveFailures = 0;

    if (entry.state === 'half-open') {
      entry.halfOpenSuccesses += 1;
      if (entry.halfOpenSuccesses >= this.policy.successThreshold) {
        this.transition(key, entry, 'closed');
      }
      return;
    }
    entry.halfOpenSuccesses = 0;
  }

  recordFailure(key: string, error?: unknown): void {
    const entry = this.entry(key);
    entry.consecutiveFailures += 1;
    entry.halfOpenSuccesses = 0;

    const shouldOpen =
      entry.state === 'half-open' || entry.consecutiveFailures >= this.policy.failureThreshold;
    if (!shouldOpen) return;

    const retryAfterMs = asTransportError(error).retryAfterMs;
    entry.opensUntil = this.now() + (retryAfterMs ?? this.policy.openMs);
    this.transition(key, entry, 'open');
  }

  async execute<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.ensureClosed(key);
    try {
      const result = await operation();
      this.recordSuccess(key);
      return result;
    } catch (error) {
      this.recordFailure(key, error);
      throw error;
    }
  }

  reset(key?: string): void {
    if (key === undefined) this.circuits.clear();
    else this.circuits.delete(key);
  }

  private entry(key: string): CircuitEntry {
    let entry = this.circuits.get(key);
    if (entry === undefined) {
      entry = { state: 'closed', consecutiveFailures: 0, halfOpenSuccesses: 0, opensUntil: 0 };
      this.circuits.set(key, entry);
    }
    return entry;
  }

  private transition(key: string, entry: CircuitEntry, to: CircuitState): void {
    if (entry.state === to) return;
    const from = entry.state;
    entry.state = to;
    if (to === 'closed') {
      entry.consecutiveFailures = 0;
      entry.halfOpenSuccesses = 0;
      entry.opensUntil = 0;
    }
    if (to === 'half-open') entry.halfOpenSuccesses = 0;
    this.hooks.onStateChange?.({ key, from, to });
  }
}

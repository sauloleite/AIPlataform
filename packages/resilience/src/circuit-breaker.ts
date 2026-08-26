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
 * Circuit breaker por chave, em memoria e por processo.
 *
 * Cada replica aprende sozinha que um deployment esta ruim. Estado compartilhado
 * entre replicas exigiria uma ida ao Redis no caminho critico da inferencia, o que
 * custa mais do que economiza (doc 02, secao 8).
 *
 * Quando a dependencia devolve `Retry-After`, ele define quanto tempo o circuito
 * fica aberto: a duracao vem de quem sabe, nao de um numero fixo.
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

  /** Lanca `CircuitOpenError` se a chave estiver bloqueada neste momento. */
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError } from '@aia/errors';
import { CircuitBreaker } from './circuit-breaker.js';

const POLICY = { failureThreshold: 3, openMs: 30_000, successThreshold: 2 };

describe('CircuitBreaker', () => {
  let now = 1_000_000;
  const clock = (): number => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('starts closed and lets calls through', () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    expect(breaker.stateOf('openai')).toBe('closed');
    expect(() => {
      breaker.ensureClosed('openai');
    }).not.toThrow();
  });

  it('opens after failureThreshold consecutive failures', () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    expect(breaker.stateOf('openai')).toBe('closed');

    breaker.recordFailure('openai');
    expect(breaker.stateOf('openai')).toBe('open');
    expect(() => {
      breaker.ensureClosed('openai');
    }).toThrow(CircuitOpenError);
  });

  it('a success resets the consecutive failure count', () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    breaker.recordSuccess('openai');
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    expect(breaker.stateOf('openai')).toBe('closed');
  });

  it('isolates keys: one bad provider does not take down the others', () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('gemini');
    expect(breaker.stateOf('gemini')).toBe('open');
    expect(breaker.stateOf('ollama')).toBe('closed');
  });

  it('uses the dependency Retry-After as the open duration', () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openai', { retryAfterMs: 120_000 });

    now += 60_000;
    expect(() => {
      breaker.ensureClosed('openai');
    }).toThrow(CircuitOpenError);

    now += 61_000;
    expect(() => {
      breaker.ensureClosed('openai');
    }).not.toThrow();
  });

  it('moves to half-open after openMs and closes after successThreshold successes', () => {
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker(POLICY, { now: clock, onStateChange });
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openai');

    now += 30_001;
    breaker.ensureClosed('openai');
    expect(breaker.stateOf('openai')).toBe('half-open');

    breaker.recordSuccess('openai');
    expect(breaker.stateOf('openai')).toBe('half-open');
    breaker.recordSuccess('openai');
    expect(breaker.stateOf('openai')).toBe('closed');

    expect(onStateChange.mock.calls.map((c) => c[0].to)).toEqual(['open', 'half-open', 'closed']);
  });

  it('a failure while half-open reopens immediately', () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openai');
    now += 30_001;
    breaker.ensureClosed('openai');

    breaker.recordFailure('openai');
    expect(breaker.stateOf('openai')).toBe('open');
  });

  it('execute records success and failure around the operation', async () => {
    const breaker = new CircuitBreaker(POLICY, { now: clock });
    await expect(breaker.execute('openai', () => Promise.resolve('ok'))).resolves.toBe('ok');

    for (let i = 0; i < 3; i += 1) {
      await expect(
        breaker.execute('openai', () => Promise.reject(new Error('502'))),
      ).rejects.toThrow();
    }
    await expect(breaker.execute('openai', () => Promise.resolve('ok'))).rejects.toThrow(
      CircuitOpenError,
    );
  });
});

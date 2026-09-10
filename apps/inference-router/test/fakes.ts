import { ConcurrencyLimitError, type Bulkhead, type BulkheadLease } from '@aia/resilience';
import { BudgetReservation } from '../src/modules/completions/domain/entities/budget-reservation.js';
import { BudgetExhaustedError } from '../src/modules/completions/domain/errors/index.js';
import { Cost } from '../src/modules/completions/domain/value-objects/index.js';
import type { Deployment } from '../src/modules/completions/domain/entities/deployment.js';
import type { UsageRecorded } from '../src/modules/completions/domain/events/usage-recorded.js';
import type {
  AliasRegistry,
  AuditRecord,
  AuditRepository,
  BudgetLedger,
  CachedCompletion,
  ChatChunk,
  ChatMessageInput,
  ChatRequestInput,
  ChatResult,
  Clock,
  EmbeddingsResult,
  Guardrail,
  GuardrailVerdict,
  ModelProvider,
  PolicyReader,
  PolicyResult,
  ReserveInput,
  SemanticCache,
  TokenEstimator,
  ToolCallOutput,
  UsagePublisher,
} from '../src/modules/completions/application/ports.js';
import type { ModelAlias } from '../src/modules/completions/domain/entities/model-alias.js';
import type { ProjectPolicySnapshot } from '../src/modules/completions/domain/services/model-selection-policy.js';

/**
 * Fakes that honour the contract for real.
 *
 * The goal is to test BEHAVIOUR — was the budget charged? did the event go out?
 * — rather than a call sequence. A test bound to mocks breaks on every
 * refactoring without pointing at a real defect.
 */

export class FakeBudgetLedger implements BudgetLedger {
  readonly reserved: ReserveInput[] = [];
  readonly committed: { reservation: BudgetReservation; actual: Cost }[] = [];
  readonly released: BudgetReservation[] = [];

  private available = true;
  private spentMicros = 0n;
  private counter = 0;

  constructor(private readonly currency = 'BRL') {}

  isAvailable(): boolean {
    return this.available;
  }

  /** Simulates Redis being down, to exercise budget_unverified mode. */
  goDown(): void {
    this.available = false;
  }

  get spent(): bigint {
    return this.spentMicros;
  }

  async reserve(input: ReserveInput): Promise<BudgetReservation> {
    this.reserved.push(input);
    if (input.blockAtLimit && this.spentMicros + input.estimated.micros > input.limitMicros) {
      throw new BudgetExhaustedError(input.projectId, input.periodEndsInSeconds);
    }
    this.counter += 1;
    return BudgetReservation.held({
      id: `res-${this.counter.toString()}`,
      projectId: input.projectId,
      estimated: input.estimated,
      periodKey: input.periodKey,
    });
  }

  async commit(reservation: BudgetReservation, actual: Cost): Promise<void> {
    this.committed.push({ reservation, actual });
    this.spentMicros += actual.micros;
    reservation.commit(actual);
  }

  async release(reservation: BudgetReservation): Promise<void> {
    // The same two guards `RedisBudgetLedger.release` applies. Without them the
    // fake recorded a release the real ledger would have ignored, so a caller
    // that releases defensively -- in a `finally`, after a commit that may or
    // may not have happened -- failed here and worked in production.
    if (reservation.isUnverified || reservation.state !== 'held') return;

    this.released.push(reservation);
    reservation.release();
  }

  zero(): Cost {
    return Cost.zero(this.currency);
  }
}

export class FakePolicyReader implements PolicyReader {
  private result: PolicyResult;
  private failure: Error | null = null;

  constructor(
    overrides: Partial<PolicyResult> = {},
    snapshot: Partial<ProjectPolicySnapshot> = {},
  ) {
    const blocked = new Set<string>();
    const policy: ProjectPolicySnapshot = {
      projectId: 'proj-1',
      classification: 'internal',
      allowedZones: ['local', 'br', 'us', 'eu', 'global'],
      isAliasAllowed: (alias) => !blocked.has(alias),
      maxOutputTokensFor: () => undefined,
      ...snapshot,
    };

    this.result = {
      policy,
      limitMicros: 100_000_000n,
      currency: 'BRL',
      blockAtLimit: true,
      periodKey: '2026-03',
      periodEndsInSeconds: 86_400,
      maxConcurrentRequests: 20,
      contentCapture: false,
      contentRetentionDays: 90,
      stale: false,
      ...overrides,
    };
  }

  /** Simulates governance being down: the cached policy stays in force, flagged. */
  goStale(): void {
    this.result = { ...this.result, stale: true };
  }

  failWith(error: Error): void {
    this.failure = error;
  }

  async forProject(): Promise<PolicyResult> {
    if (this.failure !== null) throw this.failure;
    return this.result;
  }
}

export class FakeAliasRegistry implements AliasRegistry {
  constructor(private readonly aliases: ModelAlias[]) {}

  async find(aliasId: string): Promise<ModelAlias | null> {
    return this.aliases.find((alias) => alias.id === aliasId) ?? null;
  }

  async all(): Promise<ModelAlias[]> {
    return [...this.aliases];
  }
}

/**
 * Deterministic provider.
 *
 * It always returns the same text and the same usage, which makes it possible to
 * assert exactly how much the budget should have been charged.
 */
export class FakeModelProvider implements ModelProvider {
  readonly calls: { deploymentId: string; request: ChatRequestInput }[] = [];
  configured = true;
  private failure: Error | null = null;
  private failuresRemaining = 0;
  private failMidStreamAfter: number | null = null;
  private toolCalls: ToolCallOutput[] | null = null;

  constructor(
    readonly provider: 'openai' | 'gemini' | 'anthropic' | 'ollama',
    private readonly reply = 'deterministic answer',
    private readonly usage = { promptTokens: 100, completionTokens: 50 },
  ) {}

  /** Makes the next `times` calls fail, to exercise the failover. */
  failNext(error: Error, times = 1): void {
    this.failure = error;
    this.failuresRemaining = times;
  }

  /** Makes the model ask for tools instead of answering. */
  answerWithToolCalls(calls: ToolCallOutput[]): void {
    this.toolCalls = calls;
  }

  /** Drops the stream after N chunks, to exercise the partial commit. */
  breakStreamAfter(chunks: number): void {
    this.failMidStreamAfter = chunks;
  }

  private maybeFail(): void {
    if (this.failuresRemaining > 0 && this.failure !== null) {
      this.failuresRemaining -= 1;
      throw this.failure;
    }
  }

  async chat(request: ChatRequestInput, deployment: Deployment): Promise<ChatResult> {
    this.calls.push({ deploymentId: deployment.id, request });
    this.maybeFail();
    if (this.toolCalls !== null) {
      return {
        content: '',
        finishReason: 'tool_calls',
        usage: this.usage,
        toolCalls: this.toolCalls,
      };
    }
    return { content: this.reply, finishReason: 'stop', usage: this.usage };
  }

  async *chatStream(request: ChatRequestInput, deployment: Deployment): AsyncGenerator<ChatChunk> {
    this.calls.push({ deploymentId: deployment.id, request });
    this.maybeFail();

    if (this.toolCalls !== null) {
      yield { delta: '', finishReason: 'tool_calls', usage: this.usage, toolCalls: this.toolCalls };
      return;
    }

    const words = this.reply.split(' ');
    for (const [index, word] of words.entries()) {
      if (this.failMidStreamAfter !== null && index >= this.failMidStreamAfter) {
        throw new Error('connection dropped mid-stream');
      }
      yield { delta: index === 0 ? word : ` ${word}` };
    }
    yield { delta: '', finishReason: 'stop', usage: this.usage };
  }

  async embed(input: string[], deployment: Deployment): Promise<EmbeddingsResult> {
    this.calls.push({ deploymentId: deployment.id, request: { messages: [], maxOutputTokens: 1 } });
    this.maybeFail();
    return {
      vectors: input.map((_, index) => [index, 0.1, 0.2]),
      usage: { promptTokens: this.usage.promptTokens, completionTokens: 0 },
    };
  }
}

export class FakeAuditRepository implements AuditRepository {
  readonly records: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
  }

  async find(projectId: string, requestId: string): Promise<AuditRecord | null> {
    return (
      this.records.find(
        (entry) => entry.requestId === requestId && entry.projectId === projectId,
      ) ?? null
    );
  }

  last(): AuditRecord | undefined {
    return this.records.at(-1);
  }
}

export class FakeUsagePublisher implements UsagePublisher {
  readonly published: UsageRecorded[] = [];

  async publish(usage: UsageRecorded): Promise<void> {
    this.published.push(usage);
  }

  last(): UsageRecorded | undefined {
    return this.published.at(-1);
  }
}

export class FakeGuardrail implements Guardrail {
  readonly inspected: string[] = [];
  available = true;
  private verdict: Partial<GuardrailVerdict> = {};

  respondWith(verdict: Partial<GuardrailVerdict>): void {
    this.verdict = verdict;
  }

  async inspect(text: string): Promise<GuardrailVerdict> {
    this.inspected.push(text);
    return {
      text,
      findings: [],
      redactedCount: 0,
      injectionSuspected: false,
      injectionScore: 0,
      injectionSignals: [],
      decision: 'allow',
      unverified: false,
      ...this.verdict,
    };
  }

  /** Simulates aia-guardrails being unreachable: it fails open, and says so. */
  goDown(): void {
    this.verdict = { ...this.verdict, unverified: true };
  }
}

export class FakeSemanticCache implements SemanticCache {
  enabled = false;
  readonly stored: CachedCompletion[] = [];
  lookups = 0;
  private hit: CachedCompletion | null = null;

  primeWith(completion: CachedCompletion): void {
    this.enabled = true;
    this.hit = completion;
  }

  async lookup(): Promise<CachedCompletion | null> {
    this.lookups += 1;
    return this.enabled ? this.hit : null;
  }

  async store(
    _projectId: string,
    _aliasId: string,
    _prompt: string,
    completion: CachedCompletion,
  ): Promise<void> {
    this.stored.push(completion);
  }
}

/** A simple, predictable estimate: one word, one token. */
export class WordTokenEstimator implements TokenEstimator {
  countText(text: string): number {
    return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  }

  countMessages(messages: ChatMessageInput[]): number {
    return messages.reduce((total, message) => total + this.countText(message.content ?? ''), 0);
  }
}

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-03-15T10:00:00Z')) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * A bulkhead that counts, so a test can assert what was admitted and refused.
 *
 * A fake rather than a mock: it enforces the limit for real, so a test that
 * says "the twenty-first request is refused" is testing the rule and not a
 * recorded call. `waiting` is deliberately absent -- the real one queues for
 * `acquireTimeoutMs`, and a test that had to wait two seconds to see a refusal
 * would be a slow test measuring a timer.
 */
export class CountingBulkhead implements Bulkhead {
  readonly acquired: { key: string; limit: number | undefined }[] = [];
  private readonly inFlight = new Map<string, number>();
  peak = 0;

  acquire(key: string, maxConcurrent?: number): Promise<BulkheadLease> {
    this.acquired.push({ key, limit: maxConcurrent });

    const current = this.inFlight.get(key) ?? 0;
    if (maxConcurrent !== undefined && current >= maxConcurrent) {
      return Promise.reject(new ConcurrencyLimitError(key, maxConcurrent));
    }

    this.inFlight.set(key, current + 1);
    this.peak = Math.max(this.peak, current + 1);

    let released = false;
    return Promise.resolve({
      release: (): Promise<void> => {
        if (released) return Promise.resolve();
        released = true;
        this.inFlight.set(key, Math.max(0, (this.inFlight.get(key) ?? 1) - 1));
        return Promise.resolve();
      },
    });
  }

  /** How many slots this key is holding right now. */
  inFlightFor(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }
}

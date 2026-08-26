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
    return { content: this.reply, finishReason: 'stop', usage: this.usage };
  }

  async *chatStream(request: ChatRequestInput, deployment: Deployment): AsyncGenerator<ChatChunk> {
    this.calls.push({ deploymentId: deployment.id, request });
    this.maybeFail();

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
      ...this.verdict,
    };
  }
}

export class FakeSemanticCache implements SemanticCache {
  enabled = false;
  readonly stored: CachedCompletion[] = [];
  private hit: CachedCompletion | null = null;

  primeWith(completion: CachedCompletion): void {
    this.enabled = true;
    this.hit = completion;
  }

  async lookup(): Promise<CachedCompletion | null> {
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

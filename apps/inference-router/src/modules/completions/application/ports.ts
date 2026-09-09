import type { Deployment } from '../domain/entities/deployment.js';
import type { ModelAlias } from '../domain/entities/model-alias.js';
import type { BudgetReservation } from '../domain/entities/budget-reservation.js';
import type { ProjectPolicySnapshot } from '../domain/services/model-selection-policy.js';
import type { UsageRecorded } from '../domain/events/usage-recorded.js';
import type { Cost, ProviderName } from '../domain/value-objects/index.js';

/* ------------------------------------------------------------------ */
/* Model provider                                                      */
/* ------------------------------------------------------------------ */

/** A call the model asked for. `arguments` is a JSON document the model wrote. */
export interface ToolCallOutput {
  id: string;
  name: string;
  arguments: string;
  /**
   * Opaque provider state that must travel back UNCHANGED on the next turn.
   *
   * Gemini returns a `thoughtSignature` beside every function call and rejects
   * the following turn with a 400 if it is missing. It is the model's own
   * reasoning state: the platform neither reads it nor invents it, it only
   * carries it. Dropping the assistant turn instead "works" — the API answers
   * 200 and the model ignores the tool result entirely, which is the worst of
   * the three outcomes.
   *
   * Absent for providers that need nothing echoed, and never sent to one.
   */
  providerState?: string;
}

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  /** Which call a `tool` message answers. */
  toolCallId?: string;
  /** Echoed back on the assistant turn that requested them. */
  toolCalls?: ToolCallOutput[];
}

/** What the caller declares the model may ask for. The router runs nothing. */
export interface ToolDefinitionInput {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ToolChoiceInput = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequestInput {
  messages: ChatMessageInput[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinitionInput[];
  toolChoice?: ToolChoiceInput;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  usage: TokenUsage;
  providerResponseId?: string;
  toolCalls?: ToolCallOutput[];
}

export interface ChatChunk {
  /** Incremental text. Empty on chunks that only carry metadata. */
  delta: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  /** Present on the last chunk, when the provider reports usage. */
  usage?: TokenUsage;
  /**
   * Whole tool calls, never fragments.
   *
   * Providers stream the arguments a few characters at a time; each adapter
   * reassembles them and emits the complete calls once, so no consumer has to
   * know how a given provider chops them up.
   */
  toolCalls?: ToolCallOutput[];
}

export interface EmbeddingsResult {
  vectors: number[][];
  usage: TokenUsage;
}

/**
 * A model provider, behind the canonical API.
 *
 * Adapter pattern: the use case does not know whether OpenAI, Gemini, Anthropic
 * or a local model sits behind it. Switching provider means switching an alias's
 * deployment.
 *
 * Every implementation must behave identically at the edges (LSP): a rate limit
 * becomes an error carrying `status: 429` and `retryAfterMs`, and the stream ends
 * with a chunk carrying `usage`, even if that has to be estimated.
 */
export interface ModelProvider {
  readonly provider: ProviderName;
  /** `false` when the API key is missing: the alias simply skips this provider. */
  readonly configured: boolean;

  chat(request: ChatRequestInput, deployment: Deployment, signal: AbortSignal): Promise<ChatResult>;

  chatStream(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;

  embed(input: string[], deployment: Deployment, signal: AbortSignal): Promise<EmbeddingsResult>;
}
export const MODEL_PROVIDERS = Symbol('ModelProviders');

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

export interface ReserveInput {
  projectId: string;
  estimated: Cost;
  /**
   * STABLE identifier of the budget period (`2026-03` or `2026-03-15`).
   *
   * It has to be stable because it forms part of the counter keys: deriving it
   * from the current time would land the reserve and the commit on different
   * keys.
   */
  periodKey: string;
  /** Seconds until the period rolls over. Used only as the counter TTL. */
  periodEndsInSeconds: number;
  limitMicros: bigint;
  blockAtLimit: boolean;
}

/**
 * Budget accounting with atomic reserve and commit.
 *
 * `reserve` and `commit` must be atomic across replicas: without that, N
 * concurrent calls read the same balance and all of them pass (doc 02, flow 7.1).
 */
export interface BudgetLedger {
  reserve(input: ReserveInput): Promise<BudgetReservation>;
  commit(reservation: BudgetReservation, actual: Cost): Promise<void>;
  release(reservation: BudgetReservation): Promise<void>;
  /** `false` puts the use case into `budget_unverified` mode. */
  isAvailable(): boolean;
}
export const BUDGET_LEDGER = Symbol('BudgetLedger');

/* ------------------------------------------------------------------ */
/* Policy, catalogue, audit and events                                 */
/* ------------------------------------------------------------------ */

export interface PolicyResult {
  policy: ProjectPolicySnapshot;
  limitMicros: bigint;
  currency: string;
  blockAtLimit: boolean;
  periodKey: string;
  periodEndsInSeconds: number;
  maxConcurrentRequests: number;
  contentCapture: boolean;
  /** How long this project's audit records live. Per project (doc 02 §10.2). */
  contentRetentionDays: number;
  /** Policy served from cache because the origin was unreachable. */
  stale: boolean;
}

export interface PolicyReader {
  forProject(projectId: string): Promise<PolicyResult>;
}
export const POLICY_READER = Symbol('PolicyReader');

export interface AliasRegistry {
  find(aliasId: string): Promise<ModelAlias | null>;
  all(): Promise<ModelAlias[]>;
}
export const ALIAS_REGISTRY = Symbol('AliasRegistry');

export interface AuditRecord {
  requestId: string;
  projectId: string;
  principalId: string;
  alias: string;
  deploymentId: string;
  provider: ProviderName;
  dataZone: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  currency: string;
  durationMs: number;
  errorCode?: string;
  /**
   * The content left without being inspected.
   *
   * On the audit record rather than only on the event, for the same reason
   * `dataZone` is here: this is the residency evidence, and a record that says
   * where the data was processed while staying silent about whether it was
   * redacted first answers half the question an auditor asks.
   */
  guardrailsUnverified: boolean;
  /**
   * When this record disappears.
   *
   * Per document rather than a collection-wide TTL, because retention is now a
   * project decision and one index cannot hold two answers. Mongo expires a
   * document whose `expiresAt` has passed when the index says
   * `expireAfterSeconds: 0`.
   */
  expiresAt: Date;
  /** Only populated with the project's opt-in and AFTER PII redaction. */
  redactedPrompt?: string;
  redactedCompletion?: string;
  occurredAt: Date;
}

export interface AuditRepository {
  record(entry: AuditRecord): Promise<void>;
}
export const AUDIT_REPOSITORY = Symbol('AuditRepository');

export interface UsagePublisher {
  publish(usage: UsageRecorded): Promise<void>;
}
export const USAGE_PUBLISHER = Symbol('UsagePublisher');

/* ------------------------------------------------------------------ */
/* Guardrails and cache                                                */
/* ------------------------------------------------------------------ */

export interface GuardrailFinding {
  entityType: string;
  start: number;
  end: number;
  score: number;
}

export interface GuardrailVerdict {
  text: string;
  findings: GuardrailFinding[];
  redactedCount: number;
  injectionSuspected: boolean;
  injectionScore: number;
  injectionSignals: string[];
  decision: 'allow' | 'redact' | 'block';
  /**
   * The content was NOT inspected, and `decision: 'allow'` means only that
   * nothing stood in the way.
   *
   * Required rather than optional: an adapter that fails open has to say so,
   * and a field it can forget is a field it will. The distinction matters
   * because `allow` from a working guardrail and `allow` from an unreachable
   * one are the same value with opposite meanings.
   */
  unverified: boolean;
}

export interface Guardrail {
  /** Inspects and returns the already redacted text, when the strategy is redaction. */
  inspect(text: string, projectId: string, signal?: AbortSignal): Promise<GuardrailVerdict>;
  readonly available: boolean;
}
export const GUARDRAIL = Symbol('Guardrail');

export interface CachedCompletion {
  content: string;
  usage: TokenUsage;
  deploymentId: string;
}

export interface SemanticCache {
  lookup(projectId: string, aliasId: string, prompt: string): Promise<CachedCompletion | null>;
  store(
    projectId: string,
    aliasId: string,
    prompt: string,
    completion: CachedCompletion,
  ): Promise<void>;
  readonly enabled: boolean;
}
export const SEMANTIC_CACHE = Symbol('SemanticCache');

/**
 * Admission control: how many requests one project may have in flight.
 *
 * The port is `Bulkhead` from `@aia/resilience` -- the platform does not invent
 * its own semaphore (CLAUDE.md). It is declared here so the use case can be
 * given one without knowing whether it counts in this process or in Redis.
 */
export const BULKHEAD = Symbol('Bulkhead');

/** Local token estimate, to reserve budget before calling the model. */
export interface TokenEstimator {
  countMessages(messages: ChatMessageInput[]): number;
  countText(text: string): number;
}
export const TOKEN_ESTIMATOR = Symbol('TokenEstimator');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

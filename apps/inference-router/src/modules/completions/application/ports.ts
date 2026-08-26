import type { Deployment } from '../domain/entities/deployment.js';
import type { ModelAlias } from '../domain/entities/model-alias.js';
import type { BudgetReservation } from '../domain/entities/budget-reservation.js';
import type { ProjectPolicySnapshot } from '../domain/services/model-selection-policy.js';
import type { UsageRecorded } from '../domain/events/usage-recorded.js';
import type { Cost, ProviderName } from '../domain/value-objects/index.js';

/* ------------------------------------------------------------------ */
/* Provedor de modelo                                                  */
/* ------------------------------------------------------------------ */

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
}

export interface ChatRequestInput {
  messages: ChatMessageInput[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
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
}

export interface ChatChunk {
  /** Texto incremental. Vazio em chunks que so carregam metadados. */
  delta: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  /** Presente no ultimo chunk, quando o provedor informa o consumo. */
  usage?: TokenUsage;
}

export interface EmbeddingsResult {
  vectors: number[][];
  usage: TokenUsage;
}

/**
 * Um provedor de modelo, atras da API canonica.
 *
 * Padrao Adapter: o caso de uso nao sabe se atras ha OpenAI, Gemini, Anthropic ou
 * um modelo local. Trocar de provedor e trocar o deployment de um alias.
 *
 * Toda implementacao precisa se comportar do mesmo jeito nas bordas (LSP):
 * erro de rate limit vira um erro com `status: 429` e `retryAfterMs`, e o stream
 * termina com um chunk que carrega o `usage`, mesmo que precise estima-lo.
 */
export interface ModelProvider {
  readonly provider: ProviderName;
  /** `false` quando falta chave de API: o alias simplesmente ignora este provedor. */
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
/* Orcamento                                                           */
/* ------------------------------------------------------------------ */

export interface ReserveInput {
  projectId: string;
  estimated: Cost;
  /**
   * Identificador ESTAVEL do periodo orcamentario (`2026-03` ou `2026-03-15`).
   *
   * Precisa ser estavel porque compoe a chave dos contadores: derivar da hora
   * atual faria reserva e commit caírem em chaves diferentes.
   */
  periodKey: string;
  /** Segundos ate a virada do periodo. Usado so como TTL do contador. */
  periodEndsInSeconds: number;
  limitMicros: bigint;
  blockAtLimit: boolean;
}

/**
 * Contabilidade de orcamento com reserva e commit atomicos.
 *
 * `reserve` e `commit` precisam ser atomicos entre replicas: sem isso, N chamadas
 * simultaneas leem o mesmo saldo e todas passam (doc 02, fluxo 7.1).
 */
export interface BudgetLedger {
  reserve(input: ReserveInput): Promise<BudgetReservation>;
  commit(reservation: BudgetReservation, actual: Cost): Promise<void>;
  release(reservation: BudgetReservation): Promise<void>;
  /** `false` faz o caso de uso entrar em modo `budget_unverified`. */
  isAvailable(): boolean;
}
export const BUDGET_LEDGER = Symbol('BudgetLedger');

/* ------------------------------------------------------------------ */
/* Politica, catalogo, auditoria e eventos                             */
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
  /** Politica servida do cache porque a origem estava indisponivel. */
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
  /** So preenchido com opt-in do projeto e DEPOIS da redacao de PII. */
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
/* Guardrails e cache                                                  */
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
}

export interface Guardrail {
  /** Analisa e devolve o texto ja redigido, quando a estrategia for redacao. */
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

/** Estimativa local de tokens, para reservar orcamento antes de chamar o modelo. */
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

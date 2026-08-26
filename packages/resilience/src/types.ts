/**
 * Politicas de resiliencia declaradas (doc 02, secao 8).
 *
 * Existem aqui, e nao em cada servico, para que ninguem reinvente retry.
 */

/** Erro de transporte que carrega informacao suficiente para decidir o retry. */
export interface TransportErrorLike {
  /** Status HTTP devolvido pela dependencia, quando houve resposta. */
  status?: number;
  /** Valor do header `Retry-After` ja convertido para milissegundos. */
  retryAfterMs?: number;
}

export interface TimeoutPolicy {
  /** Tempo maximo para estabelecer a conexao. */
  connectMs?: number;
  /** Tempo maximo total da operacao. */
  totalMs: number;
}

export interface RetryPolicy {
  /** Numero de tentativas ADICIONAIS. `maxAttempts: 2` significa ate 3 chamadas. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Status que justificam nova tentativa. Padrao: 408, 429 e 5xx. */
  retryableStatuses?: readonly number[];
  /** Se `false`, ignora o `Retry-After` da dependencia. Padrao: `true`. */
  honorRetryAfter?: boolean;
}

export interface CircuitBreakerPolicy {
  /** Falhas consecutivas que abrem o circuito. */
  failureThreshold: number;
  /** Tempo que o circuito fica aberto antes de testar de novo. */
  openMs: number;
  /** Sucessos em half-open necessarios para fechar. */
  successThreshold: number;
}

export interface BulkheadPolicy {
  /** Chamadas simultaneas permitidas por chave (normalmente o projeto). */
  maxConcurrent: number;
  /** Tempo maximo esperando por uma vaga antes de rejeitar. */
  acquireTimeoutMs: number;
  /** Tempo de vida da vaga, para que um processo morto nao trave o semaforo. */
  leaseTtlMs?: number;
}

export interface ResiliencePolicy {
  /** Nome usado em metricas, logs e chave do circuito. */
  name: string;
  timeout?: TimeoutPolicy;
  retry?: RetryPolicy;
  circuitBreaker?: CircuitBreakerPolicy;
  bulkhead?: BulkheadPolicy;
}

/** Contexto de uma execucao protegida. */
export interface ExecutionContext {
  /** Discrimina o circuito e o semaforo. Ex.: `openai:gpt-4o-mini` ou o project_id. */
  key?: string;
  signal?: AbortSignal;
}

export const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504] as const;

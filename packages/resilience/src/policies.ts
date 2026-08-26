import type { ResiliencePolicy } from './types.js';

/**
 * Politicas nomeadas da tabela do doc 02, secao 8.
 *
 * Um servico escolhe a politica pelo TIPO de chamada, nunca inventa numeros.
 * Mudar um valor aqui muda o comportamento de toda a plataforma: e proposital.
 */
export const POLICIES = {
  /** Inferencia nao-streaming: conexao 3 s, total 60 s, ate 2 retentativas. */
  INFERENCE: {
    name: 'inference',
    timeout: { connectMs: 3_000, totalMs: 60_000 },
    retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 8_000, honorRetryAfter: true },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
    bulkhead: { maxConcurrent: 20, acquireTimeoutMs: 2_000, leaseTtlMs: 90_000 },
  },

  /**
   * Inferencia streaming: 10 s ate o primeiro token, 30 s de inatividade.
   * Nao ha retentativa depois do primeiro token; o erro vira `stream_interrupted`.
   */
  INFERENCE_STREAMING: {
    name: 'inference_streaming',
    timeout: { connectMs: 3_000, totalMs: 10_000 },
    retry: { maxAttempts: 1, baseDelayMs: 300, maxDelayMs: 3_000, honorRetryAfter: true },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
    bulkhead: { maxConcurrent: 20, acquireTimeoutMs: 2_000, leaseTtlMs: 300_000 },
  },

  /**
   * Inferencia streaming em modelo LOCAL.
   *
   * O teto de 10 s ate o primeiro token vale para provedor em nuvem, que ja tem
   * o modelo carregado. Um modelo local precisa le-lo do disco na primeira
   * chamada, e derrubar por isso inutilizaria justamente o caminho de custo
   * zero. Depois do primeiro token, a regra e a mesma: nao ha retentativa.
   */
  INFERENCE_STREAMING_LOCAL: {
    name: 'inference_streaming_local',
    timeout: { connectMs: 2_000, totalMs: 120_000 },
    retry: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  },

  /** Inferencia nao-streaming em modelo local: mesmo motivo, teto maior. */
  INFERENCE_LOCAL: {
    name: 'inference_local',
    timeout: { connectMs: 2_000, totalMs: 180_000 },
    retry: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 2_000 },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  },

  /** Embeddings em lote: 30 s por lote, ate 3 retentativas. */
  EMBEDDINGS: {
    name: 'embeddings',
    timeout: { connectMs: 3_000, totalMs: 30_000 },
    retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000, honorRetryAfter: true },
    circuitBreaker: { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  },

  /**
   * Chamada interna (governance, registry): 2 s e uma retentativa.
   * O fallback e o cache local com TTL, tratado por quem chama.
   */
  INTERNAL: {
    name: 'internal',
    timeout: { connectMs: 1_000, totalMs: 2_000 },
    retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500 },
    circuitBreaker: { failureThreshold: 5, openMs: 10_000, successThreshold: 2 },
  },

  /**
   * Tool via MCP: sem retentativa automatica, porque acao pode nao ser idempotente
   * (doc 02, secao 8). O erro volta para o agente como observacao.
   */
  TOOL: {
    name: 'tool',
    timeout: { connectMs: 2_000, totalMs: 20_000 },
    circuitBreaker: { failureThreshold: 3, openMs: 60_000, successThreshold: 1 },
    bulkhead: { maxConcurrent: 5, acquireTimeoutMs: 1_000, leaseTtlMs: 30_000 },
  },

  /** Guardrails: rapido e obrigatorio; falhar aberto seria um risco de seguranca. */
  GUARDRAIL: {
    name: 'guardrail',
    timeout: { connectMs: 500, totalMs: 3_000 },
    retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 400 },
    circuitBreaker: { failureThreshold: 10, openMs: 15_000, successThreshold: 3 },
  },
} as const satisfies Record<string, ResiliencePolicy>;

export type PolicyName = keyof typeof POLICIES;

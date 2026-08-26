/**
 * Convencoes de atributos de telemetria (doc 02, secao 11 e ADR-009).
 *
 * `gen_ai.*` segue as Semantic Conventions for Generative AI do OpenTelemetry,
 * para que a telemetria seja portavel entre backends.
 * `aia.*` sao os atributos de negocio que todo span da plataforma carrega.
 */

/** Atributos de negocio obrigatorios em todo span. */
export const AIA_ATTR = {
  PROJECT_ID: 'aia.project_id',
  PRINCIPAL_ID: 'aia.principal_id',
  PRINCIPAL_TYPE: 'aia.principal_type',
  ALIAS: 'aia.alias',
  DATA_CLASSIFICATION: 'aia.data_classification',
  DEPLOYMENT_ID: 'aia.deployment_id',
  DATA_ZONE: 'aia.data_zone',
  /** Politica servida do cache porque o governance estava indisponivel. */
  POLICY_STALE: 'aia.policy_stale',
  /** Orcamento nao verificado porque o Redis estava indisponivel. */
  BUDGET_UNVERIFIED: 'aia.budget_unverified',
  BUDGET_RESERVED_MICROS: 'aia.budget.reserved_micros',
  BUDGET_COMMITTED_MICROS: 'aia.budget.committed_micros',
  CACHE_HIT: 'aia.cache_hit',
  GUARDRAIL_DECISION: 'aia.guardrail.decision',
  GUARDRAIL_REDACTED_COUNT: 'aia.guardrail.redacted_count',
  ERROR_CODE: 'aia.error_code',
} as const;

/** Subconjunto das convencoes GenAI que a plataforma emite. */
export const GEN_AI_ATTR = {
  SYSTEM: 'gen_ai.system',
  OPERATION_NAME: 'gen_ai.operation.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
} as const;

/** Nomes de span das convencoes GenAI. */
export const GEN_AI_SPAN = {
  CHAT: 'chat',
  EMBEDDINGS: 'embeddings',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
} as const;

/** Metricas de SLI da plataforma (doc 02, secao 11). */
export const AIA_METRIC = {
  TIME_TO_FIRST_TOKEN: 'aia.inference.time_to_first_token',
  INFERENCE_DURATION: 'aia.inference.duration',
  TOKENS_USED: 'aia.inference.tokens',
  COST_MICROS: 'aia.inference.cost_micros',
  BUDGET_REJECTIONS: 'aia.budget.rejections',
  CIRCUIT_STATE_CHANGES: 'aia.resilience.circuit_state_changes',
} as const;

/**
 * Telemetry attribute conventions (reference doc 02 §11, ADR-009).
 *
 * `gen_ai.*` follows the OpenTelemetry Semantic Conventions for Generative AI,
 * so the telemetry stays portable across backends.
 * `aia.*` are the business attributes every platform span carries.
 */

/** Business attributes required on every span. */
export const AIA_ATTR = {
  PROJECT_ID: 'aia.project_id',
  /**
   * The platform's own id for the call, and the only way back from a trace to
   * what was actually said.
   *
   * A span carries timings and token counts; the redacted content lives in the
   * router's audit record, keyed by this. Without it on the span, somebody
   * looking at a slow or wrong call in the console can see everything about it
   * except the thing they came for.
   */
  REQUEST_ID: 'aia.request_id',
  PRINCIPAL_ID: 'aia.principal_id',
  PRINCIPAL_TYPE: 'aia.principal_type',
  ALIAS: 'aia.alias',
  DATA_CLASSIFICATION: 'aia.data_classification',
  DEPLOYMENT_ID: 'aia.deployment_id',
  DATA_ZONE: 'aia.data_zone',
  /** Policy served from cache because governance was unreachable. */
  POLICY_STALE: 'aia.policy_stale',
  /** Budget not verified because Redis was unreachable. */
  BUDGET_UNVERIFIED: 'aia.budget_unverified',
  /**
   * Content went out uninspected because guardrails were unreachable.
   *
   * The response has carried this since ADR-026 and no trace could show it,
   * which is the wrong way round: the caller is told once, and the platform
   * needs to be able to answer "how much traffic went out unredacted last
   * Tuesday" long afterwards.
   */
  GUARDRAILS_UNVERIFIED: 'aia.guardrails_unverified',
  BUDGET_RESERVED_MICROS: 'aia.budget.reserved_micros',
  BUDGET_COMMITTED_MICROS: 'aia.budget.committed_micros',
  CACHE_HIT: 'aia.cache_hit',
  GUARDRAIL_DECISION: 'aia.guardrail.decision',
  GUARDRAIL_REDACTED_COUNT: 'aia.guardrail.redacted_count',
  ERROR_CODE: 'aia.error_code',
} as const;

/** The subset of the GenAI conventions this platform emits. */
export const GEN_AI_ATTR = {
  /**
   * Superseded by `PROVIDER_NAME`, and emitted anyway.
   *
   * The GenAI conventions renamed this to `gen_ai.provider.name`. Both are set
   * during the transition because a dashboard, a saved query or a backend's own
   * GenAI view may know either one, and a span that carries only the new name
   * silently drops out of anything built on the old.
   */
  SYSTEM: 'gen_ai.system',
  PROVIDER_NAME: 'gen_ai.provider.name',
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

/** Span names from the GenAI conventions. */
export const GEN_AI_SPAN = {
  CHAT: 'chat',
  EMBEDDINGS: 'embeddings',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
} as const;

/** Platform SLI metrics (reference doc 02 §11). */
export const AIA_METRIC = {
  TIME_TO_FIRST_TOKEN: 'aia.inference.time_to_first_token',
  INFERENCE_DURATION: 'aia.inference.duration',
  TOKENS_USED: 'aia.inference.tokens',
  COST_MICROS: 'aia.inference.cost_micros',
  BUDGET_REJECTIONS: 'aia.budget.rejections',
  CIRCUIT_STATE_CHANGES: 'aia.resilience.circuit_state_changes',
} as const;

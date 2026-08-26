/**
 * Catalogo de codigos de erro estaveis da plataforma.
 *
 * O codigo e parte do contrato publico: clientes decidem comportamento por ele.
 * Mudar o valor de um codigo e breaking change; adicionar um novo, nao.
 */
export const ERROR_CODES = {
  // Orcamento e cota (OWASP LLM10)
  BUDGET_EXHAUSTED: 'budget_exhausted',
  QUOTA_EXCEEDED: 'quota_exceeded',
  CONCURRENCY_LIMIT: 'concurrency_limit',

  // Roteamento de modelo (ADR-010)
  NO_COMPATIBLE_DEPLOYMENT: 'no_compatible_deployment',
  ALIAS_NOT_FOUND: 'alias_not_found',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  ALL_DEPLOYMENTS_FAILED: 'all_deployments_failed',

  // Streaming
  STREAM_INTERRUPTED: 'stream_interrupted',

  // Guardrails (OWASP LLM01, LLM02)
  GUARDRAIL_BLOCKED: 'guardrail_blocked',
  PROMPT_INJECTION_SUSPECTED: 'prompt_injection_suspected',

  // Identidade e autorizacao
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  TOKEN_EXPIRED: 'token_expired',
  INVALID_TOKEN: 'invalid_token',

  // Tenant
  PROJECT_REQUIRED: 'project_required',
  PROJECT_NOT_FOUND: 'project_not_found',

  // Contrato
  VALIDATION_FAILED: 'validation_failed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',

  // Dependencias
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  CIRCUIT_OPEN: 'circuit_open',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Base do campo `type` do Problem Details. Aponta para a documentacao do erro. */
export const PROBLEM_TYPE_BASE = 'https://aia.dev/errors';

export function problemTypeFor(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code}`;
}

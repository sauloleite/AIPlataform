/**
 * Catalogue of stable platform error codes.
 *
 * The code is part of the public contract: clients branch on it. Changing a
 * value is a breaking change; adding a new one is not.
 */
export const ERROR_CODES = {
  // Budget and quota (OWASP LLM10)
  BUDGET_EXHAUSTED: 'budget_exhausted',
  QUOTA_EXCEEDED: 'quota_exceeded',
  CONCURRENCY_LIMIT: 'concurrency_limit',

  // Model routing (ADR-010)
  NO_COMPATIBLE_DEPLOYMENT: 'no_compatible_deployment',
  ALIAS_NOT_FOUND: 'alias_not_found',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  ALL_DEPLOYMENTS_FAILED: 'all_deployments_failed',

  // Streaming
  STREAM_INTERRUPTED: 'stream_interrupted',

  // Guardrails (OWASP LLM01, LLM02)
  GUARDRAIL_BLOCKED: 'guardrail_blocked',
  PROMPT_INJECTION_SUSPECTED: 'prompt_injection_suspected',

  // Identity and authorisation
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  TOKEN_EXPIRED: 'token_expired',
  INVALID_TOKEN: 'invalid_token',

  // Tenancy
  PROJECT_REQUIRED: 'project_required',
  PROJECT_NOT_FOUND: 'project_not_found',

  // Contract
  VALIDATION_FAILED: 'validation_failed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',

  // Dependencies
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  CIRCUIT_OPEN: 'circuit_open',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Base for the Problem Details `type` field. Points at the error's docs. */
export const PROBLEM_TYPE_BASE = 'https://aia.dev/errors';

export function problemTypeFor(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code}`;
}

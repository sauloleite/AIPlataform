import { ERROR_CODES, type ErrorCode, problemTypeFor } from './catalog.js';
import { type DomainError, InternalError, isDomainError } from './domain-error.js';

/**
 * Problem Details for HTTP APIs (RFC 9457).
 *
 * Platform extensions: `code` (stable, from the catalogue), `trace_id` for
 * correlation, and the domain error's `details`. No field carries PII.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  trace_id?: string;
  retry_after?: number;
  [extension: string]: unknown;
}

export interface ProblemContext {
  /** Request path, for the `instance` field. */
  instance?: string;
  /** trace_id from the W3C traceparent, to correlate with telemetry. */
  traceId?: string;
}

const TITLES: Record<string, string> = {
  [ERROR_CODES.BUDGET_EXHAUSTED]: 'Project budget exhausted',
  [ERROR_CODES.QUOTA_EXCEEDED]: 'Quota exceeded',
  [ERROR_CODES.CONCURRENCY_LIMIT]: 'Project concurrency limit reached',
  [ERROR_CODES.NO_COMPATIBLE_DEPLOYMENT]:
    'No deployment compatible with the project data classification',
  [ERROR_CODES.ALIAS_NOT_FOUND]: 'Unknown model alias',
  [ERROR_CODES.PROVIDER_UNAVAILABLE]: 'Model provider unavailable',
  [ERROR_CODES.ALL_DEPLOYMENTS_FAILED]: 'Every deployment for the alias failed',
  [ERROR_CODES.STREAM_INTERRUPTED]: 'Stream interrupted',
  [ERROR_CODES.GUARDRAIL_BLOCKED]: 'Content blocked by a guardrail',
  [ERROR_CODES.PROMPT_INJECTION_SUSPECTED]: 'Suspected prompt injection',
  [ERROR_CODES.UNAUTHENTICATED]: 'Not authenticated',
  [ERROR_CODES.FORBIDDEN]: 'Access denied',
  [ERROR_CODES.TOKEN_EXPIRED]: 'Token expired',
  [ERROR_CODES.INVALID_TOKEN]: 'Invalid token',
  [ERROR_CODES.PROJECT_REQUIRED]: 'Project required',
  [ERROR_CODES.PROJECT_NOT_FOUND]: 'Project not found',
  [ERROR_CODES.VALIDATION_FAILED]: 'Invalid request',
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: 'Idempotency conflict',
  [ERROR_CODES.NOT_FOUND]: 'Resource not found',
  [ERROR_CODES.CONFLICT]: 'State conflict',
  [ERROR_CODES.UPSTREAM_TIMEOUT]: 'Dependency timed out',
  [ERROR_CODES.CIRCUIT_OPEN]: 'Dependency circuit open',
  [ERROR_CODES.ASSET_NOT_FOUND]: 'Asset not found',
  [ERROR_CODES.ASSET_NOT_PUBLISHED]: 'Asset has no published version',
  [ERROR_CODES.ASSET_VERSION_CONFLICT]: 'Asset changed since it was read',
  [ERROR_CODES.STORE_NOT_FOUND]: 'Vector store not found',
  [ERROR_CODES.DOCUMENT_NOT_FOUND]: 'Document not found',
  [ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: 'Media type not supported',
  [ERROR_CODES.EMBEDDING_DIMENSION_MISMATCH]: 'Embedding width does not match the store',
  [ERROR_CODES.INGESTION_FAILED]: 'Document ingestion failed',
  [ERROR_CODES.TOOL_NOT_FOUND]: 'Tool not found',
  [ERROR_CODES.TOOL_NOT_ALLOWED]: 'Tool not allowed in this project',
  [ERROR_CODES.TOOL_ARGUMENTS_INVALID]: 'Tool arguments do not match its schema',
  [ERROR_CODES.TOOL_RATE_LIMITED]: 'Tool rate limit reached',
  [ERROR_CODES.APPROVAL_REQUIRED]: 'Human approval required',
  [ERROR_CODES.TOOL_EXECUTION_FAILED]: 'Tool execution failed',
  [ERROR_CODES.AGENT_STEP_LIMIT]: 'Agent step limit reached',
  [ERROR_CODES.INTERNAL_ERROR]: 'Internal error',
};

export function titleFor(code: ErrorCode): string {
  return TITLES[code] ?? 'Error';
}

/** Translates a domain error into the Problem Details response body. */
export function toProblemDetails(error: DomainError, context: ProblemContext = {}): ProblemDetails {
  const problem: ProblemDetails = {
    type: problemTypeFor(error.code),
    title: titleFor(error.code),
    status: error.status,
    detail: error.message,
    code: error.code,
    ...error.details,
  };

  if (context.instance !== undefined) problem.instance = context.instance;
  if (context.traceId !== undefined) problem.trace_id = context.traceId;

  const retryAfter = error.details['retry_after'];
  if (typeof retryAfter === 'number') problem.retry_after = retryAfter;

  return problem;
}

/**
 * Converts anything thrown into Problem Details.
 *
 * An unknown error becomes a 500 with no detail: the internal message never
 * reaches the client. The stack goes to the structured log instead, correlated
 * by trace_id.
 */
export function fromUnknown(error: unknown, context: ProblemContext = {}): ProblemDetails {
  if (isDomainError(error)) return toProblemDetails(error, context);
  return toProblemDetails(new InternalError(), context);
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

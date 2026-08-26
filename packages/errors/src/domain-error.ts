import { ERROR_CODES, type ErrorCode } from './catalog.js';

/**
 * Extra detail carried by a domain error.
 * These become Problem Details extensions, so they must be serialisable and
 * must never contain PII.
 */
export type ErrorDetails = Record<string, string | number | boolean | null | string[] | number[]>;

/**
 * Root of every business exception.
 *
 * The domain throws typed subclasses; the presentation layer translates them
 * into Problem Details. Never return `null` to signal an error.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  /** Suggested HTTP status. Presentation may override, but rarely should. */
  abstract readonly status: number;
  /** When `true`, the client may retry without changing the request. */
  readonly retryable: boolean = false;
  readonly details: ErrorDetails;

  protected constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    // `captureStackTrace` only exists on V8. Node's types declare it as always
    // present, which makes the optional call look redundant when it is not.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    Error.captureStackTrace?.(this, new.target);
  }
}

/** An error that maps to no known business rule. */
export class InternalError extends DomainError {
  readonly code = ERROR_CODES.INTERNAL_ERROR;
  readonly status = 500;

  constructor(message = 'Internal error', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ValidationError extends DomainError {
  readonly code = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details);
  }
}

export class NotFoundError extends DomainError {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly status = 404;

  constructor(resource: string, id: string) {
    super(`${resource} not found`, { resource, id });
  }
}

export class ConflictError extends DomainError {
  readonly code = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details);
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = ERROR_CODES.UNAUTHENTICATED;
  readonly status = 401;

  constructor(message = 'Missing or invalid credential', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ForbiddenError extends DomainError {
  readonly code = ERROR_CODES.FORBIDDEN;
  readonly status = 403;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details);
  }
}

export class ProjectRequiredError extends DomainError {
  readonly code = ERROR_CODES.PROJECT_REQUIRED;
  readonly status = 400;

  constructor() {
    super('The X-Project-Id header is required: project is the platform tenant');
  }
}

export class UpstreamTimeoutError extends DomainError {
  readonly code = ERROR_CODES.UPSTREAM_TIMEOUT;
  readonly status = 504;
  override readonly retryable = true;

  constructor(target: string, timeoutMs: number) {
    super(`Timed out calling ${target}`, { target, timeout_ms: timeoutMs });
  }
}

export class CircuitOpenError extends DomainError {
  readonly code = ERROR_CODES.CIRCUIT_OPEN;
  readonly status = 503;
  override readonly retryable = true;

  constructor(target: string, reopensInMs: number) {
    super(`Circuit open for ${target}`, { target, reopens_in_ms: reopensInMs });
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

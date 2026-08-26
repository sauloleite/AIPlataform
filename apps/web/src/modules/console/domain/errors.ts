/**
 * The platform answers errors as Problem Details (RFC 9457) with a stable
 * `code`. The console keys its behaviour off that code, never off the message:
 * the message is for a human and may be reworded, the code is the contract.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  trace_id?: string;
  retry_after?: number;
  [extension: string]: unknown;
}

export class PlatformError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'PlatformError';
  }

  get code(): string {
    return this.problem.code;
  }

  get status(): number {
    return this.problem.status;
  }

  get retryAfterSeconds(): number | undefined {
    return this.problem.retry_after;
  }
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}

/**
 * What to tell the user, per stable code.
 *
 * Anything not listed falls back to the platform's own `detail`, which is
 * already safe to show: an unknown server error arrives with no detail at all.
 */
const MESSAGES: Record<string, string> = {
  budget_exhausted: 'This project has used up its budget for the period.',
  quota_exceeded: 'The project quota has been exceeded.',
  concurrency_limit: 'Too many requests in flight for this project. Try again shortly.',
  no_compatible_deployment:
    'No model is allowed to serve this project. Its data classification permits fewer zones than this alias covers.',
  alias_not_found: 'That model alias does not exist.',
  provider_unavailable: 'The model provider is unavailable.',
  all_deployments_failed: 'Every model behind this alias failed.',
  stream_interrupted: 'The stream was interrupted before it finished.',
  guardrail_blocked: 'A guardrail blocked this content.',
  prompt_injection_suspected: 'This message looks like a prompt injection attempt.',
  unauthenticated: 'Your session has expired. Sign in again.',
  forbidden: 'You do not have access to this project.',
  token_expired: 'Your session has expired. Sign in again.',
  invalid_token: 'Your session is no longer valid. Sign in again.',
  project_required: 'Pick a project first.',
  project_not_found: 'That project does not exist.',
  validation_failed: 'The request is invalid.',
  conflict: 'That change conflicts with the current state.',
  upstream_timeout: 'A dependency timed out.',
  circuit_open: 'A dependency is failing and has been taken out of rotation.',
};

/**
 * Codes whose own detail beats any phrasing we could write.
 *
 * A validation error names the field and the allowed values; a generic "the
 * request is invalid" throws that away and leaves the user guessing which of
 * six inputs was wrong.
 */
const PREFER_SERVER_DETAIL = new Set(['validation_failed', 'conflict']);

export function messageFor(error: unknown): string {
  if (!isPlatformError(error)) {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }

  const detail = error.problem.detail;
  if (PREFER_SERVER_DETAIL.has(error.code) && detail !== undefined && detail !== '') {
    return detail;
  }

  return MESSAGES[error.code] ?? detail ?? error.problem.title;
}

/**
 * What to say when a SIGN-IN was refused.
 *
 * `unauthenticated` means two different things depending on where it happens.
 * On any other request it means the session is gone, and "sign in again" is the
 * right advice. On the sign-in form itself there was never a session to lose,
 * and telling someone their session expired sends them looking for a problem
 * that does not exist instead of at the email they mistyped.
 *
 * Only the caller knows which situation it is in, which is why this is separate
 * from `messageFor` rather than a branch inside it.
 */
export function messageForSignIn(error: unknown): string {
  if (isPlatformError(error) && SESSION_GONE.has(error.code)) {
    return 'That email and password do not match an account.';
  }
  return messageFor(error);
}

/** Codes that mean the session is gone and the user has to sign in again. */
const SESSION_GONE = new Set(['unauthenticated', 'token_expired', 'invalid_token']);

export function requiresSignIn(error: unknown): boolean {
  return isPlatformError(error) && SESSION_GONE.has(error.code);
}

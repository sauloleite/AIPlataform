import { ERROR_CODES, type ProblemDetails } from '@aia/errors';

/**
 * What the platform refused, as an exception a caller can branch on.
 *
 * Deliberately NOT a `DomainError`. Those are what a service throws when one of
 * its own rules says no, and `isDomainError` is how the HTTP layer decides that
 * a message is safe to return. An answer received from somewhere else is not
 * that, however similar it looks, and a client-side type that claimed to be one
 * would eventually see its message echoed to a third party as though the local
 * service had produced it.
 *
 * `code` comes from the same catalogue the services use, because that is the
 * part of the contract clients branch on: `budget_exhausted` means the same
 * thing whoever reads it.
 */
export class PlatformError extends Error {
  /** From the shared catalogue; typed loosely because a newer platform may send one this build does not know. */
  readonly code: string;
  readonly status: number;
  /** The platform's own trace id, so a report can be tied to a trace. */
  readonly traceId: string | undefined;
  /** Present on 429 and 503. Seconds, as the platform sent it. */
  readonly retryAfterSeconds: number | undefined;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'PlatformError';
    this.code = problem.code;
    this.status = problem.status;
    this.problem = problem;
    this.traceId = typeof problem.trace_id === 'string' ? problem.trace_id : undefined;
    this.retryAfterSeconds = problem.retry_after;
  }
}

/**
 * Reads a failed response as Problem Details, and copes when it is not.
 *
 * A proxy in front of the platform answers with its own HTML on a 502, and a
 * client that assumed JSON would throw a parse error naming a line and column
 * instead of the status that actually happened. The status is always known;
 * everything else is best effort.
 */
export async function errorFrom(response: Response, instance: string): Promise<PlatformError> {
  const fallback: ProblemDetails = {
    type: 'about:blank',
    title: response.statusText === '' ? 'Request failed' : response.statusText,
    status: response.status,
    detail: `The platform answered ${response.status.toString()} for ${instance}`,
    code: ERROR_CODES.INTERNAL_ERROR,
    instance,
  };

  // No content-type check: parsing is the check. A body that is not JSON throws
  // here and lands in the catch below, so a header saying `application/json`
  // over an HTML error page is handled by the same line -- and a proxy that
  // lies about its content type is exactly the case this has to survive.
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('status' in body)) {
      return new PlatformError(fallback);
    }
    return new PlatformError({ ...fallback, ...(body as Partial<ProblemDetails>) });
  } catch {
    return new PlatformError(fallback);
  }
}

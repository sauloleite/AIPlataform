/**
 * Readiness: can this process serve traffic?
 *
 * For the console the answer is the same as liveness. It holds no connection
 * pool to warm and no cache to fill, and it renders usefully even when the
 * platform behind it is degraded — a project page missing its budget is still
 * worth serving. Reporting not-ready because a downstream service is down would
 * take the console out of rotation exactly when someone needs to look at it.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}

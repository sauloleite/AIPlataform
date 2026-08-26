/**
 * Liveness: is this process able to answer at all?
 *
 * It queries no dependency, on purpose. Restarting the console because
 * governance blinked would turn a degradation the platform is designed to
 * survive into an outage of the only screen an operator has to see it with.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}

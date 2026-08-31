import { NextResponse } from 'next/server';

import { PlatformError, isPlatformError } from '../../modules/console/domain/errors';
import type { RunStreamEvent } from '../../modules/agents/domain/transcript';

/**
 * Forwarding the runtime's event stream to the browser.
 *
 * Shared by starting a run and resuming one, because they are the same loop
 * seen from two entry points — and a second copy of this framing is a second
 * place for the error handling to be subtly different.
 */
export function runStreamResponse(
  open: () => AsyncGenerator<RunStreamEvent>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        for await (const event of open()) {
          // The reader went away: stop pulling from the runtime rather than
          // holding a connection open for nobody.
          if (signal.aborted) break;
          send(event.name, event.data);
        }
      } catch (error) {
        // The headers went out with the first byte, so a failure here can only
        // reach the client as an event inside the stream.
        send('error', {
          code: isPlatformError(error) ? error.code : 'internal_error',
          message: isPlatformError(error)
            ? (error.problem.detail ?? error.problem.title)
            : 'The run failed.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells any nginx in front not to buffer, which would hold the whole run
      // back and deliver it in one block at the end.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** An error BEFORE the stream starts still gets a status and Problem Details. */
export function problemResponse(error?: unknown, detail?: string): Response {
  if (isPlatformError(error)) {
    return NextResponse.json(error.problem, {
      status: error.status,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  }

  const problem = new PlatformError({
    type: 'https://aia.dev/errors/validation_failed',
    title: 'Invalid request',
    status: 400,
    code: 'validation_failed',
    ...(detail !== undefined && { detail }),
  });

  return NextResponse.json(problem.problem, {
    status: problem.status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

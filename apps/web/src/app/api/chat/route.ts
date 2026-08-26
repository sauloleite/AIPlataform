import { NextResponse } from 'next/server';

import { getContainer } from '../../../container';
import { PlatformError, isPlatformError } from '../../../modules/console/domain/errors';

/**
 * The one route handler in the console, and the reason is streaming.
 *
 * Every other write goes through a Server Action, which cannot stream: an action
 * returns once. A chat answer arrives token by token, so it needs a real
 * response the browser can read incrementally.
 *
 * This is the BFF boundary. The browser posts here with no credential of its
 * own; the access token is read from the httpOnly cookie server-side and
 * attached on the way out. The platform JWT never exists in the browser.
 */
export const dynamic = 'force-dynamic';

interface ChatBody {
  projectId?: unknown;
  alias?: unknown;
  message?: unknown;
  history?: unknown;
  maxTokens?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const { authorize, sendChatMessage } = await getContainer();

  let accessToken: string;
  try {
    ({ accessToken } = await authorize.execute());
  } catch (error) {
    return problemResponse(error);
  }

  const body = (await request.json()) as ChatBody;
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const alias = typeof body.alias === 'string' ? body.alias : '';
  const message = typeof body.message === 'string' ? body.message : '';

  if (projectId === '' || alias === '' || message.trim() === '') {
    return problemResponse(
      new PlatformError({
        type: 'https://aia.dev/errors/validation_failed',
        title: 'Invalid request',
        status: 400,
        detail: 'projectId, alias and message are all required.',
        code: 'validation_failed',
      }),
    );
  }

  const history = Array.isArray(body.history)
    ? body.history.filter(isTurn).slice(-20) // keeps the prompt bounded
    : [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        for await (const update of sendChatMessage.execute(accessToken, {
          projectId,
          alias,
          history,
          message,
          ...(typeof body.maxTokens === 'number' && { maxTokens: body.maxTokens }),
        })) {
          send(update.kind, update);
        }
      } catch (error) {
        // The headers went out with the first byte, so a failure here can only
        // reach the client as an event inside the stream.
        send('error', {
          kind: 'error',
          code: isPlatformError(error) ? error.code : 'internal_error',
          message: isPlatformError(error) ? error.problem.detail : 'The request failed.',
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
      // Tells any nginx in front not to buffer, which would hold the whole
      // answer back and deliver it in one block at the end.
      'X-Accel-Buffering': 'no',
    },
  });
}

function isTurn(value: unknown): value is { role: 'user' | 'assistant'; content: string } {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as { role?: unknown; content?: unknown };
  return (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string';
}

/** An error BEFORE the stream starts still gets a status and Problem Details. */
function problemResponse(error: unknown): Response {
  if (isPlatformError(error)) {
    return NextResponse.json(error.problem, {
      status: error.status,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  }
  return NextResponse.json(
    {
      type: 'https://aia.dev/errors/internal_error',
      title: 'Internal error',
      status: 500,
      code: 'internal_error',
    },
    { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

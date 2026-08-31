import { getContainer } from '../../../../../container';
import { runStreamResponse, problemResponse } from '../../../run-stream';

/**
 * Starting an agent run, streamed.
 *
 * A route handler rather than a Server Action, for the same reason chat is one:
 * an action returns once, and a run emits tool calls and an approval prompt
 * along the way.
 *
 * This is the BFF boundary. The browser posts here with no credential of its
 * own; the platform token is read from the httpOnly cookie server-side. It
 * never exists in the browser.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const { agentId } = await context.params;
  const { authorize, runAgent } = await getContainer();

  let accessToken: string;
  try {
    ({ accessToken } = await authorize.execute());
  } catch (error) {
    return problemResponse(error);
  }

  const body = (await request.json()) as {
    projectId?: unknown;
    input?: unknown;
    threadId?: unknown;
  };
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const input = typeof body.input === 'string' ? body.input.trim() : '';

  if (projectId === '' || input === '') {
    return problemResponse(undefined, 'projectId and input are both required.');
  }

  return runStreamResponse(
    () =>
      runAgent.start(accessToken, projectId, agentId, {
        text: input,
        ...(typeof body.threadId === 'string' && { threadId: body.threadId }),
      }),
    request.signal,
  );
}

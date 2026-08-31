import { getContainer } from '../../../../../container';
import { runStreamResponse, problemResponse } from '../../../run-stream';

/** Resuming a held run. Streams, because approving continues the same loop. */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  const { authorize, runAgent } = await getContainer();

  let accessToken: string;
  try {
    ({ accessToken } = await authorize.execute());
  } catch (error) {
    return problemResponse(error);
  }

  const body = (await request.json()) as {
    projectId?: unknown;
    toolCallId?: unknown;
    approved?: unknown;
    reason?: unknown;
  };
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : '';

  if (projectId === '' || toolCallId === '') {
    return problemResponse(undefined, 'projectId and toolCallId are both required.');
  }

  return runStreamResponse(
    () =>
      runAgent.approve(accessToken, projectId, runId, {
        toolCallId,
        // Anything other than an explicit `false` is an approval only because
        // the field is optional in the contract; the UI always sends it.
        approved: body.approved !== false,
        ...(typeof body.reason === 'string' && { reason: body.reason }),
      }),
    request.signal,
  );
}

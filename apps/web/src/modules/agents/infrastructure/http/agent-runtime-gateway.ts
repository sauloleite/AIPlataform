import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import { parseSse } from '../../../console/domain/sse';
import type { AgentRuntimeGateway } from '../../application/ports';
import type { RunStreamEvent } from '../../domain/transcript';

/**
 * aia-agent-runtime over HTTP. Server-side only.
 *
 * There is no timeout on the stream: a run waits for a person to approve, and
 * a clock that gives up after thirty seconds would turn every considered
 * decision into a dropped connection. The request is aborted when the browser
 * disconnects instead, which is the signal that actually means nobody is
 * waiting any more.
 */
export class HttpAgentRuntimeGateway implements AgentRuntimeGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  startRun(
    accessToken: string,
    projectId: string,
    agentId: string,
    input: { text: string; threadId?: string },
  ): AsyncGenerator<RunStreamEvent> {
    return this.stream(
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs?stream=true`,
      accessToken,
      projectId,
      { input: input.text, ...(input.threadId !== undefined && { thread_id: input.threadId }) },
    );
  }

  approve(
    accessToken: string,
    projectId: string,
    runId: string,
    decision: { toolCallId: string; approved: boolean; reason?: string },
  ): AsyncGenerator<RunStreamEvent> {
    return this.stream(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approve?stream=true`,
      accessToken,
      projectId,
      {
        tool_call_id: decision.toolCallId,
        approved: decision.approved,
        ...(decision.reason !== undefined && { reason: decision.reason }),
      },
    );
  }

  private async *stream(
    url: string,
    accessToken: string,
    projectId: string,
    body: unknown,
  ): AsyncGenerator<RunStreamEvent> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Project-Id': projectId,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    // Before the first byte a real status is still possible, and that is the
    // only place a 403 or a 404 can be reported as one.
    if (!response.ok || response.body === null) throw await problemFrom(response);

    for await (const event of parseSse(response.body)) {
      yield { name: event.name, data: event.data };
    }
  }
}

async function problemFrom(response: Response): Promise<PlatformError> {
  try {
    return new PlatformError((await response.json()) as ProblemDetails);
  } catch {
    return new PlatformError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: 'internal_error',
    });
  }
}

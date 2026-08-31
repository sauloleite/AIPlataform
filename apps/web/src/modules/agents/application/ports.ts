import type { RunStreamEvent } from '../domain/transcript';

/**
 * aia-agent-runtime, as the console needs it.
 *
 * Its own port rather than a method on the one platform gateway: a page that
 * runs an agent should not depend on an interface that also knows how to
 * approve a budget.
 */
export interface AgentRuntimeGateway {
  startRun(
    accessToken: string,
    projectId: string,
    agentId: string,
    input: { text: string; threadId?: string },
  ): AsyncGenerator<RunStreamEvent>;

  approve(
    accessToken: string,
    projectId: string,
    runId: string,
    decision: { toolCallId: string; approved: boolean; reason?: string },
  ): AsyncGenerator<RunStreamEvent>;
}

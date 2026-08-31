import type { AgentRuntimeGateway } from '../ports';
import type { RunStreamEvent } from '../../domain/transcript';

/**
 * Starting a run, and resuming one a person held.
 *
 * Thin on purpose: the runtime owns the loop, the gateway owns the allow-list,
 * and the console owns neither. What it adds is the BFF property — the caller
 * hands over an access token read from an httpOnly cookie, and nothing in the
 * browser ever holds it.
 */
export class RunAgentInPlayground {
  constructor(private readonly runtime: AgentRuntimeGateway) {}

  start(
    accessToken: string,
    projectId: string,
    agentId: string,
    input: { text: string; threadId?: string },
  ): AsyncGenerator<RunStreamEvent> {
    return this.runtime.startRun(accessToken, projectId, agentId, input);
  }

  approve(
    accessToken: string,
    projectId: string,
    runId: string,
    decision: { toolCallId: string; approved: boolean; reason?: string },
  ): AsyncGenerator<RunStreamEvent> {
    return this.runtime.approve(accessToken, projectId, runId, decision);
  }
}

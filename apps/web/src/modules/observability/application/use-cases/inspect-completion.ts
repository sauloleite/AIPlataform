import type { CompletionRecord, PlatformGateway } from '../../../console/application/ports';

/**
 * What a call said, next to the trace of how it went.
 *
 * Its own use case rather than a branch inside `InspectTrace`, because the two
 * come from different services and fail differently: the trace comes from the
 * tracing backend and the content from the router's audit, and a person who may
 * read the first is not necessarily allowed to read the second.
 */
export interface CompletionView {
  record: CompletionRecord | null;
  /** Why there is nothing to show, when there is nothing to show. */
  reason?: 'no-request-id' | 'unreadable';
}

export class InspectCompletion {
  constructor(private readonly platform: PlatformGateway) {}

  async execute(
    accessToken: string,
    projectId: string,
    requestId: string | undefined,
  ): Promise<CompletionView> {
    // A trace from before `aia.request_id` existed, or one that never reached
    // the router. Distinguished from a failed read because they are fixed in
    // different places.
    if (requestId === undefined) return { record: null, reason: 'no-request-id' };

    try {
      return {
        record: await this.platform.readCompletionRecord(accessToken, projectId, requestId),
      };
    } catch {
      // Swallowed on purpose: the commonest cause is a viewer without
      // `auditor` or `project_owner`, which is a correct refusal rather than
      // an error the trace view should show as broken. The panel says the
      // content could not be read, and the spans stay on the screen.
      return { record: null, reason: 'unreadable' };
    }
  }
}

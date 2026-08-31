import { Injectable } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { ToolExecutionFailedError } from '../../domain/errors/index.js';
import type { ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';

/**
 * A tool behind a plain HTTP endpoint described by an OpenAPI document.
 *
 * The arguments are posted as the body. Resolving the document to pick a path
 * and method belongs to a later step; what this proves is the governed path
 * around the call, which is what the gateway exists for.
 *
 * The endpoint gets the credential from its CONNECTION and nothing else. It
 * used to receive the caller's platform token, which is a valid AIA JWT: a
 * third-party endpoint holding one can turn round and act as that user against
 * this platform (ADR-020).
 */
@Injectable()
export class OpenApiExecutor implements ToolExecutor {
  // POLICIES.TOOL, not INTERNAL: a tool action may not be idempotent, so it
  // carries NO automatic retry (reference doc 02 §8). Retrying a side effect
  // on the caller's behalf is how one click becomes three.
  private readonly executor = new ResilienceExecutor(POLICIES.TOOL);

  supports(toolType: string): boolean {
    return toolType === 'openapi';
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    const endpoint = invocation.tool.endpoint;
    if (endpoint === undefined) {
      throw new ToolExecutionFailedError(invocation.tool.toolId, 'The tool has no endpoint');
    }

    const started = Date.now();
    const result = await this.executor.execute<unknown>(async (signal) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(invocation.credential !== undefined && {
            [invocation.credential.header]: invocation.credential.value,
          }),
        },
        body: JSON.stringify(invocation.arguments),
        signal,
      });

      if (!response.ok) {
        throw new ToolExecutionFailedError(
          invocation.tool.toolId,
          `The tool answered ${response.status.toString()}`,
        );
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    });

    return { result, durationMs: Date.now() - started };
  }
}

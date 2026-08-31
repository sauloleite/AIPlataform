import { Injectable } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { ToolExecutionFailedError } from '../../domain/errors/index.js';
import type { ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';

/**
 * The `file_search` built-in: retrieval from a vector store.
 *
 * Reaches aia-knowledge with the CALLER's token, so the search is trimmed to
 * what that person may read. A built-in that searched as the gateway would
 * hand every document to whoever asked.
 */
@Injectable()
export class KnowledgeSearchExecutor implements ToolExecutor {
  // POLICIES.TOOL, like every other executor. INTERNAL was wrong twice over:
  // its two-second ceiling is a policy read, not a retrieval that embeds the
  // query through a model first, and a search that times out at two seconds
  // reaches the agent as a failed tool it then has to apologise for.
  private readonly executor = new ResilienceExecutor(POLICIES.TOOL);

  constructor(private readonly knowledgeUrl: string) {}

  supports(toolType: string): boolean {
    return toolType === 'builtin';
  }

  private static text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    if (invocation.tool.builtinId !== 'file_search') {
      throw new ToolExecutionFailedError(
        invocation.tool.toolId,
        `The built-in "${invocation.tool.builtinId ?? 'unknown'}" is not available yet`,
      );
    }
    if (this.knowledgeUrl === '') {
      throw new ToolExecutionFailedError(
        invocation.tool.toolId,
        'file_search needs aia-knowledge, which is not configured',
      );
    }

    // Arguments come from a model. Anything that is not a string is not an
    // id or a question, and coercing it would send "[object Object]" upstream.
    const storeId = KnowledgeSearchExecutor.text(invocation.arguments['store_id']);
    const query = KnowledgeSearchExecutor.text(invocation.arguments['query']);
    if (storeId === '' || query === '') {
      throw new ToolExecutionFailedError(
        invocation.tool.toolId,
        'file_search needs a store_id and a query',
      );
    }

    const started = Date.now();
    const body = await this.executor.execute<{ results?: unknown[] }>(async (signal) => {
      const response = await fetch(
        `${this.knowledgeUrl}/v1/stores/${encodeURIComponent(storeId)}/search`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${invocation.accessToken}`,
            'X-Project-Id': invocation.projectId,
          },
          body: JSON.stringify({ query, top_k: Number(invocation.arguments['top_k'] ?? 5) || 5 }),
          signal,
        },
      );

      if (!response.ok) {
        throw new ToolExecutionFailedError(
          invocation.tool.toolId,
          `Knowledge answered ${response.status.toString()}`,
        );
      }
      return (await response.json()) as { results?: unknown[] };
    });

    return { result: body.results ?? [], durationMs: Date.now() - started };
  }
}

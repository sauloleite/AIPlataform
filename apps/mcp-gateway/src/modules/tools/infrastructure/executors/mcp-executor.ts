import { Injectable } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { ToolExecutionFailedError } from '../../domain/errors/index.js';
import type { ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';

interface JsonRpcResponse {
  result?: { content?: unknown; isError?: boolean };
  error?: { code?: number; message?: string };
}

/**
 * A tool on an MCP server, over streamable HTTP.
 *
 * The server is authenticated with the tool's CONNECTION -- never with the
 * caller's platform token. That token is a valid AIA JWT, and an MCP server
 * holding one can act as that user against this platform (ADR-020). Only the
 * minimum headers travel: a credential in a header nobody needs is a
 * credential in a log nobody meant to write.
 *
 * Who is asking travels as `X-Project-Id` and in the audit record, not as a
 * bearer token somebody else can spend.
 */
@Injectable()
export class McpExecutor implements ToolExecutor {
  // POLICIES.TOOL, not INTERNAL: a tool action may not be idempotent, so it
  // carries NO automatic retry (reference doc 02 §8). Retrying a side effect
  // on the caller's behalf is how one click becomes three.
  private readonly executor = new ResilienceExecutor(POLICIES.TOOL);

  supports(toolType: string): boolean {
    return toolType === 'mcp';
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    const endpoint = invocation.tool.endpoint;
    if (endpoint === undefined) {
      throw new ToolExecutionFailedError(invocation.tool.toolId, 'The tool has no endpoint');
    }

    const started = Date.now();
    const body = await this.executor.execute<JsonRpcResponse>(async (signal) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(invocation.credential !== undefined && {
            [invocation.credential.header]: invocation.credential.value,
          }),
          'X-Project-Id': invocation.projectId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: invocation.tool.name, arguments: invocation.arguments },
        }),
        signal,
      });

      if (!response.ok) {
        throw new ToolExecutionFailedError(
          invocation.tool.toolId,
          `The MCP server answered ${response.status.toString()}`,
        );
      }
      return (await response.json()) as JsonRpcResponse;
    });

    if (body.error !== undefined) {
      throw new ToolExecutionFailedError(
        invocation.tool.toolId,
        body.error.message ?? 'The MCP server reported an error',
      );
    }

    return { result: body.result?.content ?? body.result, durationMs: Date.now() - started };
  }
}

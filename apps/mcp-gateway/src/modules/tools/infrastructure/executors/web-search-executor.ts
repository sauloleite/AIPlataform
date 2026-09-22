import { Injectable } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { InvalidToolArgumentsError, ToolExecutionFailedError } from '../../domain/errors/index.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';
import { SearchBackendError, type SearchBackend } from '../web-search/search-backends.js';

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 400;

/**
 * The `web_search` built-in.
 *
 * A null backend is a platform with web search switched off -- the way a
 * missing provider key disables that provider and nothing else.
 */
@Injectable()
export class WebSearchExecutor implements ToolExecutor {
  // POLICIES.TOOL: a search is idempotent, but the table has no separate row
  // for it and inventing numbers here is exactly what reference doc 02 §8
  // forbids.
  private readonly executor = new ResilienceExecutor(POLICIES.TOOL);

  constructor(private readonly backend: SearchBackend | null) {}

  supports(tool: ToolDefinition): boolean {
    return tool.toolType === 'builtin' && tool.builtinId === 'web_search';
  }

  async unavailableReason(): Promise<string | null> {
    if (this.backend === null) {
      return 'No web search backend is configured on this platform (WEB_SEARCH_PROVIDER)';
    }
    return this.backend.unavailableReason();
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    const toolId = invocation.tool.toolId;
    if (this.backend === null) {
      throw new ToolExecutionFailedError(toolId, 'No web search backend is configured');
    }
    const backend = this.backend;

    const raw = invocation.arguments['query'];
    const query = typeof raw === 'string' ? raw.trim() : '';
    if (query === '') throw new InvalidToolArgumentsError(toolId, 'web-search needs a query');
    if (query.length > MAX_QUERY_LENGTH) {
      throw new InvalidToolArgumentsError(
        toolId,
        `The query is longer than ${MAX_QUERY_LENGTH.toString()} characters; search for less at once`,
      );
    }

    const maxResults = clampResults(invocation.arguments['max_results']);

    const started = Date.now();
    try {
      const results = await this.executor.execute(
        (signal) => backend.search({ query, maxResults, signal }),
        { key: backend.name },
      );
      return { result: { query, results }, durationMs: Date.now() - started };
    } catch (error) {
      if (error instanceof SearchBackendError) {
        throw new ToolExecutionFailedError(toolId, error.message);
      }
      throw error;
    }
  }
}

/** A model asks for 50 results as readily as for 5; the context window pays for it. */
function clampResults(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(raw)));
}

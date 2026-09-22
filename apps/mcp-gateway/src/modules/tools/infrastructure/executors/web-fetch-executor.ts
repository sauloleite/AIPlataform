import { Injectable } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { InvalidToolArgumentsError, ToolExecutionFailedError } from '../../domain/errors/index.js';
import { fetchTargetRefusal } from '../../domain/services/public-address.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';
import {
  RefusedTargetError,
  UnreadableContentError,
  type PublicWebClient,
} from '../web/public-web-client.js';
import { readableText } from '../web/readable-text.js';

/**
 * What a model is handed from one page. About five thousand tokens: enough for
 * an article, and a ceiling on how much of a stranger's text -- and whatever
 * instructions it hides -- lands in one turn.
 */
export const MAX_TEXT_CHARACTERS = 20_000;

export function isReadableContentType(contentType: string): boolean {
  return (
    contentType === '' ||
    contentType.startsWith('text/') ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'application/json' ||
    contentType.endsWith('+json') ||
    contentType === 'application/xml' ||
    contentType.endsWith('+xml')
  );
}

/**
 * The `web_fetch` built-in.
 *
 * The page's text is returned as data and never interpreted here. Whatever it
 * says reaches the model as a tool result, which is where an agent loop has to
 * treat it as untrusted (OWASP LLM01) -- this executor's job is only to make
 * sure the platform's own network is not what gets read.
 */
@Injectable()
export class WebFetchExecutor implements ToolExecutor {
  // POLICIES.TOOL, keyed by host below: a dead site opening a breaker shared
  // with every other site would take web-fetch away from every project.
  private readonly executor = new ResilienceExecutor(POLICIES.TOOL);

  constructor(
    private readonly client: PublicWebClient,
    /** Set when the operator switched web-fetch off for the whole platform. */
    private readonly disabledReason: string | null = null,
  ) {}

  supports(tool: ToolDefinition): boolean {
    return tool.toolType === 'builtin' && tool.builtinId === 'web_fetch';
  }

  async unavailableReason(): Promise<string | null> {
    return this.disabledReason;
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    const toolId = invocation.tool.toolId;
    if (this.disabledReason !== null)
      throw new ToolExecutionFailedError(toolId, this.disabledReason);

    const raw = invocation.arguments['url'];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') throw new InvalidToolArgumentsError(toolId, 'web-fetch needs a url');

    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new InvalidToolArgumentsError(toolId, `"${text.slice(0, 200)}" is not a valid URL`);
    }
    // Checked before the breaker, so a refused address never counts as the
    // site failing.
    const refusal = fetchTargetRefusal(url);
    if (refusal !== null) throw new InvalidToolArgumentsError(toolId, refusal);

    const started = Date.now();
    let page;
    try {
      page = await this.executor.execute((signal) => this.client.get(url, signal), {
        key: `web-fetch:${url.hostname}`,
      });
    } catch (error) {
      if (error instanceof RefusedTargetError)
        throw new InvalidToolArgumentsError(toolId, error.message);
      if (error instanceof UnreadableContentError)
        throw new ToolExecutionFailedError(toolId, error.message);
      throw error;
    }

    if (page.status >= 400) {
      throw new ToolExecutionFailedError(toolId, `The page answered ${page.status.toString()}`);
    }

    const isHtml = page.contentType === '' || page.contentType.includes('html');
    const readable: { title?: string; text: string } = isHtml
      ? readableText(page.body)
      : { text: page.body.trim() };
    const cut = readable.text.length > MAX_TEXT_CHARACTERS;

    return {
      result: {
        url: page.url,
        status: page.status,
        content_type: page.contentType,
        ...(readable.title !== undefined && { title: readable.title }),
        text: cut ? readable.text.slice(0, MAX_TEXT_CHARACTERS) : readable.text,
        truncated: page.truncated || cut,
      },
      durationMs: Date.now() - started,
    };
  }
}

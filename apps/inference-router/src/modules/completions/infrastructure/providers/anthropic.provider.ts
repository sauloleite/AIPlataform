import { Injectable } from '@nestjs/common';
import type { Deployment } from '../../domain/entities/deployment.js';
import type {
  ChatChunk,
  ChatRequestInput,
  ChatResult,
  EmbeddingsResult,
  ModelProvider,
} from '../../application/ports.js';
import { ensureOk, readSseLines, sseData } from './http.js';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl: string;
  version: string;
}

interface AnthropicMessageResponse {
  id?: string;
  content?: { type?: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function normalizeStopReason(raw: string | undefined): ChatResult['finishReason'] {
  if (raw === undefined) return null;
  if (raw === 'max_tokens') return 'length';
  if (raw === 'tool_use') return 'tool_calls';
  if (raw === 'refusal') return 'content_filter';
  return 'stop';
}

/**
 * Anthropic adapter (Messages API).
 *
 * Two differences this adapter hides from the rest of the platform: the system
 * instruction is a separate `system` field, and `max_tokens` is REQUIRED. No use
 * case needs to know either.
 */
@Injectable()
export class AnthropicProvider implements ModelProvider {
  readonly provider = 'anthropic' as const;

  constructor(private readonly options: AnthropicOptions) {}

  get configured(): boolean {
    return this.options.apiKey !== '';
  }

  private headers(accept?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.options.apiKey,
      'anthropic-version': this.options.version,
      ...(accept !== undefined && { Accept: accept }),
    };
  }

  private body(request: ChatRequestInput, deployment: Deployment, stream: boolean): string {
    const system = request.messages
      .filter((message) => message.role === 'system' && message.content !== null)
      .map((message) => message.content ?? '')
      .join('\n\n');

    return JSON.stringify({
      model: deployment.model,
      // Required by the Messages API; the value already arrives capped by the
      // alias and the project policy.
      max_tokens: request.maxOutputTokens,
      messages: request.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content ?? '' })),
      ...(system !== '' && { system }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.topP !== undefined && { top_p: request.topP }),
      ...(request.stop !== undefined && { stop_sequences: request.stop }),
      stream,
    });
  }

  async chat(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const response = await fetch(`${this.options.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(request, deployment, false),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as AnthropicMessageResponse;
    return {
      content: (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(''),
      finishReason: normalizeStopReason(payload.stop_reason),
      usage: {
        promptTokens: payload.usage?.input_tokens ?? 0,
        completionTokens: payload.usage?.output_tokens ?? 0,
      },
      ...(payload.id !== undefined && { providerResponseId: payload.id }),
    };
  }

  async *chatStream(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    const response = await fetch(`${this.options.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: this.body(request, deployment, true),
      signal,
    });
    await ensureOk(response, this.provider);

    // Usage arrives across two events: `message_start` carries the input and
    // `message_delta` the accumulated output. We keep the input for the end.
    let promptTokens = 0;

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null) continue;

      const event = JSON.parse(data) as AnthropicStreamEvent;

      if (event.type === 'message_start') {
        promptTokens = event.message?.usage?.input_tokens ?? 0;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { delta: event.delta.text ?? '' };
        continue;
      }

      if (event.type === 'message_delta') {
        yield {
          delta: '',
          finishReason: normalizeStopReason(event.delta?.stop_reason),
          usage: {
            promptTokens,
            completionTokens: event.usage?.output_tokens ?? 0,
          },
        };
      }
    }
  }

  /**
   * Anthropic offers no embeddings endpoint.
   *
   * An embeddings alias simply does not include deployments from this provider;
   * the executor skips any that arrive here through a configuration mistake.
   */
  async embed(
    _input: string[],
    _deployment: Deployment,
    _signal: AbortSignal,
  ): Promise<EmbeddingsResult> {
    void _input;
    void _deployment;
    void _signal;
    throw new Error('Anthropic exposes no embeddings endpoint; use a different alias');
  }
}

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
import {
  ToolCallAccumulator,
  messagesBody,
  readToolCalls,
  toolsBody,
  type OpenAiToolCall,
} from './openai-tools.js';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl: string;
  organization?: string;
}

interface OpenAiChoice {
  message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  delta?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  finish_reason?: string | null;
}

interface OpenAiChatResponse {
  id?: string;
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiEmbeddingsResponse {
  data?: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens?: number };
}

const FINISH_REASONS = ['stop', 'length', 'content_filter', 'tool_calls'] as const;

function normalizeFinishReason(raw: string | null | undefined): ChatResult['finishReason'] {
  if (raw === null || raw === undefined) return null;
  return FINISH_REASONS.includes(raw as (typeof FINISH_REASONS)[number])
    ? (raw as ChatResult['finishReason'])
    : 'stop';
}

/** One streamed event as a chunk. Tool calls are NOT read here: they arrive in
 *  fragments and are only whole once the stream has ended. */
function toChunk(payload: OpenAiChatResponse): ChatChunk {
  const choice = payload.choices?.[0];
  const chunk: ChatChunk = { delta: choice?.delta?.content ?? '' };

  const finishReason = normalizeFinishReason(choice?.finish_reason);
  if (finishReason !== null) chunk.finishReason = finishReason;
  // With `include_usage`, the real consumption arrives in the last event.
  if (payload.usage !== undefined) {
    chunk.usage = {
      promptTokens: payload.usage.prompt_tokens ?? 0,
      completionTokens: payload.usage.completion_tokens ?? 0,
    };
  }
  return chunk;
}

/**
 * OpenAI adapter.
 *
 * The platform's canonical API is ALREADY OpenAI-compatible, so this adapter is
 * nearly a passthrough. It exists anyway because it is the point where transport
 * errors become typed errors and where `usage` is normalised — without that,
 * substitutability between providers (LSP) would be lost.
 */
@Injectable()
export class OpenAiProvider implements ModelProvider {
  readonly provider = 'openai' as const;

  constructor(private readonly options: OpenAiOptions) {}

  get configured(): boolean {
    return this.options.apiKey !== '';
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
      ...(this.options.organization !== undefined && {
        'OpenAI-Organization': this.options.organization,
      }),
    };
  }

  private body(request: ChatRequestInput, deployment: Deployment, stream: boolean): string {
    return JSON.stringify({
      model: deployment.model,
      messages: messagesBody(request.messages),
      ...toolsBody(request),
      max_completion_tokens: request.maxOutputTokens,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.topP !== undefined && { top_p: request.topP }),
      ...(request.stop !== undefined && { stop: request.stop }),
      stream,
      ...(stream && { stream_options: { include_usage: true } }),
    });
  }

  async chat(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(request, deployment, false),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as OpenAiChatResponse;
    const choice = payload.choices?.[0];

    const toolCalls = readToolCalls(choice?.message?.tool_calls);

    return {
      content: choice?.message?.content ?? '',
      finishReason: normalizeFinishReason(choice?.finish_reason),
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
      },
      ...(payload.id !== undefined && { providerResponseId: payload.id }),
      ...(toolCalls.length > 0 && { toolCalls }),
    };
  }

  async *chatStream(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: this.body(request, deployment, true),
      signal,
    });
    await ensureOk(response, this.provider);

    const calls = new ToolCallAccumulator();

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null) continue;
      if (data === '[DONE]') break;

      const payload = JSON.parse(data) as OpenAiChatResponse;
      calls.add(payload.choices?.[0]?.delta?.tool_calls);
      yield toChunk(payload);
    }

    // The assembled calls come after the loop, never mid-stream: only once the
    // provider has stopped sending fragments is any of them complete.
    if (!calls.isEmpty) yield { delta: '', toolCalls: calls.drain() };
  }

  async embed(
    input: string[],
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<EmbeddingsResult> {
    const response = await fetch(`${this.options.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: deployment.model, input }),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as OpenAiEmbeddingsResponse;
    const sorted = [...(payload.data ?? [])].sort((a, b) => a.index - b.index);

    return {
      vectors: sorted.map((entry) => entry.embedding),
      usage: { promptTokens: payload.usage?.prompt_tokens ?? 0, completionTokens: 0 },
    };
  }
}

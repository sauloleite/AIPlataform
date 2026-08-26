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

export interface OpenAiOptions {
  apiKey: string;
  baseUrl: string;
  organization?: string;
}

interface OpenAiChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
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

/**
 * Adapter OpenAI.
 *
 * A API canonica da plataforma JA e compativel com OpenAI, entao este adapter e
 * quase passthrough. Ele existe assim mesmo porque e o ponto onde erros de
 * transporte viram erros tipados e onde o `usage` e normalizado — sem isso, a
 * substituibilidade entre provedores (LSP) se perderia.
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
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name !== undefined && { name: message.name }),
      })),
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

    return {
      content: choice?.message?.content ?? '',
      finishReason: normalizeFinishReason(choice?.finish_reason),
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
      },
      ...(payload.id !== undefined && { providerResponseId: payload.id }),
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

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null) continue;
      if (data === '[DONE]') return;

      const payload = JSON.parse(data) as OpenAiChatResponse;
      const choice = payload.choices?.[0];
      const delta = choice?.delta?.content ?? '';

      const chunk: ChatChunk = { delta };
      const finishReason = normalizeFinishReason(choice?.finish_reason);
      if (finishReason !== null) chunk.finishReason = finishReason;
      // Com `include_usage`, o consumo real vem no ultimo evento.
      if (payload.usage !== undefined) {
        chunk.usage = {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          completionTokens: payload.usage.completion_tokens ?? 0,
        };
      }
      yield chunk;
    }
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

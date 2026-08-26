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
 * Adapter Anthropic (Messages API).
 *
 * Duas diferencas que o adapter esconde do resto da plataforma: a instrucao de
 * sistema e um campo `system` separado, e `max_tokens` e OBRIGATORIO. Nenhum
 * caso de uso precisa saber disso.
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
      // Obrigatorio na Messages API; o valor ja vem limitado pelo alias e pela politica.
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

    // O consumo chega em dois eventos: `message_start` traz a entrada e
    // `message_delta` traz a saida acumulada. Guardamos a entrada para o final.
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
   * A Anthropic nao oferece endpoint de embeddings.
   *
   * Um alias de embeddings simplesmente nao inclui deployments deste provedor;
   * o executor pula qualquer um que chegue aqui por engano de configuracao.
   */
  async embed(
    _input: string[],
    _deployment: Deployment,
    _signal: AbortSignal,
  ): Promise<EmbeddingsResult> {
    void _input;
    void _deployment;
    void _signal;
    throw new Error('A Anthropic nao expoe endpoint de embeddings; use outro alias');
  }
}

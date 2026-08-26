import { Injectable } from '@nestjs/common';
import type { Deployment } from '../../domain/entities/deployment.js';
import type {
  ChatChunk,
  ChatRequestInput,
  ChatResult,
  EmbeddingsResult,
  ModelProvider,
} from '../../application/ports.js';
import { ensureOk } from './http.js';

export interface OllamaOptions {
  baseUrl: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  prompt_eval_count?: number;
}

/**
 * Ollama adapter: open models running on the machine itself.
 *
 * This is what makes the platform usable with no paid API key, and what serves
 * projects classified `restricted`: the data zone is `local`, so content never
 * leaves the host (ADR-010).
 *
 * The protocol is NDJSON, not SSE: each line is one complete JSON object.
 */
@Injectable()
export class OllamaProvider implements ModelProvider {
  readonly provider = 'ollama' as const;

  constructor(private readonly options: OllamaOptions) {}

  get configured(): boolean {
    return this.options.baseUrl !== '';
  }

  private body(request: ChatRequestInput, deployment: Deployment, stream: boolean): string {
    return JSON.stringify({
      model: deployment.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content ?? '',
      })),
      stream,
      options: {
        num_predict: request.maxOutputTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.topP !== undefined && { top_p: request.topP }),
        ...(request.stop !== undefined && { stop: request.stop }),
      },
    });
  }

  async chat(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: this.body(request, deployment, false),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as OllamaChatResponse;
    return {
      content: payload.message?.content ?? '',
      finishReason: payload.done_reason === 'length' ? 'length' : 'stop',
      usage: {
        promptTokens: payload.prompt_eval_count ?? 0,
        completionTokens: payload.eval_count ?? 0,
      },
    };
  }

  async *chatStream(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: this.body(request, deployment, true),
      signal,
    });
    await ensureOk(response, this.provider);

    for await (const line of readNdjson(response)) {
      const payload = JSON.parse(line) as OllamaChatResponse;
      const chunk: ChatChunk = { delta: payload.message?.content ?? '' };

      if (payload.done === true) {
        chunk.finishReason = payload.done_reason === 'length' ? 'length' : 'stop';
        chunk.usage = {
          promptTokens: payload.prompt_eval_count ?? 0,
          completionTokens: payload.eval_count ?? 0,
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
    const response = await fetch(`${this.options.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: deployment.model, input }),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as OllamaEmbedResponse;
    return {
      vectors: payload.embeddings ?? [],
      usage: { promptTokens: payload.prompt_eval_count ?? 0, completionTokens: 0 },
    };
  }
}

/** NDJSON: one complete JSON object per line. */
async function* readNdjson(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (body === null) return;

  // Tipagem explicita: `response.body` chega como `ReadableStream<any>` nos
  // tipos padrao, e sem isto todo `read()` propaga `any` adiante.
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') yield line;
        index = buffer.indexOf('\n');
      }
    }
    if (buffer.trim() !== '') yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

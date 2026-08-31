import { Injectable } from '@nestjs/common';
import type { Deployment } from '../../domain/entities/deployment.js';
import type {
  ChatChunk,
  ChatMessageInput,
  ChatRequestInput,
  ChatResult,
  EmbeddingsResult,
  ModelProvider,
  ToolCallOutput,
} from '../../application/ports.js';
import { ensureOk } from './http.js';

export interface OllamaOptions {
  baseUrl: string;
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
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
      messages: request.messages.map(toOllamaMessage),
      ...(request.tools !== undefined &&
        request.tools.length > 0 && {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              ...(tool.description !== undefined && { description: tool.description }),
              ...(tool.parameters !== undefined && { parameters: tool.parameters }),
            },
          })),
        }),
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
    const toolCalls = readOllamaToolCalls(payload.message?.tool_calls);

    return {
      content: payload.message?.content ?? '',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : lengthOrStop(payload.done_reason),
      usage: {
        promptTokens: payload.prompt_eval_count ?? 0,
        completionTokens: payload.eval_count ?? 0,
      },
      ...(toolCalls.length > 0 && { toolCalls }),
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

    // Ollama sends each call complete, so there is nothing to reassemble; they
    // are held back only so the last chunk carries them alongside the usage.
    let toolCalls: ToolCallOutput[] = [];

    for await (const line of readNdjson(response)) {
      const payload = JSON.parse(line) as OllamaChatResponse;
      const chunk: ChatChunk = { delta: payload.message?.content ?? '' };

      const calls = readOllamaToolCalls(payload.message?.tool_calls);
      if (calls.length > 0) toolCalls = [...toolCalls, ...calls];

      if (payload.done === true) {
        chunk.finishReason =
          toolCalls.length > 0 ? 'tool_calls' : lengthOrStop(payload.done_reason);
        chunk.usage = {
          promptTokens: payload.prompt_eval_count ?? 0,
          completionTokens: payload.eval_count ?? 0,
        };
        if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
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

function lengthOrStop(reason: string | undefined): 'length' | 'stop' {
  return reason === 'length' ? 'length' : 'stop';
}

/**
 * Ollama identifies a call by nothing at all — no id — and sends `arguments` as
 * an object rather than a string. Both are normalised here so a consumer can
 * match a result to its call the same way whatever served the request.
 */
function readOllamaToolCalls(raw: OllamaToolCall[] | undefined): ToolCallOutput[] {
  if (raw === undefined) return [];
  return raw
    .filter((call) => call.function?.name !== undefined && call.function.name !== '')
    .map((call, index) => ({
      id: `call_${index.toString()}`,
      name: call.function?.name ?? '',
      arguments:
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? {}),
    }));
}

function toOllamaMessage(message: ChatMessageInput): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content ?? '',
    ...(message.toolCalls !== undefined &&
      message.toolCalls.length > 0 && {
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: parseArguments(call.arguments) },
        })),
      }),
    // `tool_name` is how Ollama pairs a result with its call: it has no ids.
    ...(message.role === 'tool' && message.name !== undefined && { tool_name: message.name }),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // The model wrote this string; malformed JSON is its mistake, not a crash.
    return {};
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

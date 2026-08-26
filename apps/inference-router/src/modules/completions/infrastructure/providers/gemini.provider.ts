import { Injectable } from '@nestjs/common';
import type { Deployment } from '../../domain/entities/deployment.js';
import type {
  ChatChunk,
  ChatMessageInput,
  ChatRequestInput,
  ChatResult,
  EmbeddingsResult,
  ModelProvider,
} from '../../application/ports.js';
import { ensureOk, readSseLines, sseData } from './http.js';

/**
 * Two protocols coexist in Gemini:
 *
 * - `interactions` (POST /v1beta/interactions) is the current interface, GA
 *   since June 2026, and replaced `generateContent` as the default.
 * - `generateContent` (POST /v1beta/models/{model}:generateContent) remains
 *   supported and still matters for anyone pinned to an older API version.
 *
 * The mode is configurable because the Gemini API changed shape twice since
 * 2024, and switching protocol must not require changing production code.
 */
export type GeminiProtocol = 'interactions' | 'generate-content';

export interface GeminiOptions {
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  protocol?: GeminiProtocol;
}

interface InteractionsUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface InteractionsStep {
  type?: string;
  content?: { type?: string; text?: string }[];
}

interface InteractionsResponse {
  id?: string;
  status?: string;
  output_text?: string;
  steps?: InteractionsStep[];
  usage?: InteractionsUsage;
  delta?: { text?: string };
}

interface GenerateContentResponse {
  responseId?: string;
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface EmbedContentResponse {
  embedding?: { values?: number[] };
  embeddings?: { values?: number[] }[];
}

/** Splits the system instruction out: in Gemini it is a field of its own. */
function splitSystem(messages: ChatMessageInput[]): {
  system: string | undefined;
  turns: ChatMessageInput[];
} {
  const systemParts = messages
    .filter((message) => message.role === 'system' && message.content !== null)
    .map((message) => message.content ?? '');
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    turns: messages.filter((message) => message.role !== 'system'),
  };
}

function normalizeFinishReason(raw: string | undefined): ChatResult['finishReason'] {
  if (raw === undefined) return null;
  if (raw === 'MAX_TOKENS') return 'length';
  if (raw === 'SAFETY' || raw === 'PROHIBITED_CONTENT') return 'content_filter';
  return 'stop';
}

/** `usage` appears under two different names depending on the event. Accept both. */
function readUsage(usage: InteractionsUsage | undefined): {
  promptTokens: number;
  completionTokens: number;
} {
  return {
    promptTokens: usage?.total_input_tokens ?? usage?.prompt_tokens ?? 0,
    completionTokens: usage?.total_output_tokens ?? usage?.completion_tokens ?? 0,
  };
}

function textOfSteps(payload: InteractionsResponse): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  return (payload.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

@Injectable()
export class GeminiProvider implements ModelProvider {
  readonly provider = 'gemini' as const;
  private readonly protocol: GeminiProtocol;

  constructor(private readonly options: GeminiOptions) {
    this.protocol = options.protocol ?? 'interactions';
  }

  get configured(): boolean {
    return this.options.apiKey !== '';
  }

  private headers(accept?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // Key in a header, never in the query string: URLs leak into proxy logs.
      'x-goog-api-key': this.options.apiKey,
      ...(accept !== undefined && { Accept: accept }),
    };
  }

  private get root(): string {
    return `${this.options.baseUrl}/${this.options.apiVersion}`;
  }

  private interactionsBody(
    request: ChatRequestInput,
    deployment: Deployment,
    stream: boolean,
  ): string {
    const { system, turns } = splitSystem(request.messages);
    return JSON.stringify({
      model: deployment.model,
      // A single turn becomes a plain string, as in the documentation example.
      input:
        turns.length === 1 && turns[0]?.role === 'user'
          ? (turns[0].content ?? '')
          : turns.map((message) => ({
              role: message.role === 'assistant' ? 'model' : 'user',
              content: [{ type: 'text', text: message.content ?? '' }],
            })),
      ...(system !== undefined && { system_instruction: system }),
      generation_config: {
        max_output_tokens: request.maxOutputTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.topP !== undefined && { top_p: request.topP }),
        ...(request.stop !== undefined && { stop_sequences: request.stop }),
      },
      stream,
      // The router owns history and audit; the provider keeps no state.
      store: false,
    });
  }

  private generateContentBody(request: ChatRequestInput, _deployment: Deployment): string {
    void _deployment;
    const { system, turns } = splitSystem(request.messages);
    return JSON.stringify({
      contents: turns.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content ?? '' }],
      })),
      ...(system !== undefined && { systemInstruction: { parts: [{ text: system }] } }),
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.topP !== undefined && { topP: request.topP }),
        ...(request.stop !== undefined && { stopSequences: request.stop }),
      },
    });
  }

  async chat(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    if (this.protocol === 'generate-content') {
      return this.chatViaGenerateContent(request, deployment, signal);
    }

    const response = await fetch(`${this.root}/interactions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.interactionsBody(request, deployment, false),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as InteractionsResponse;
    return {
      content: textOfSteps(payload),
      finishReason: payload.status === 'completed' ? 'stop' : null,
      usage: readUsage(payload.usage),
      ...(payload.id !== undefined && { providerResponseId: payload.id }),
    };
  }

  private async chatViaGenerateContent(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const response = await fetch(`${this.root}/models/${deployment.model}:generateContent`, {
      method: 'POST',
      headers: this.headers(),
      body: this.generateContentBody(request, deployment),
      signal,
    });
    await ensureOk(response, this.provider);

    const payload = (await response.json()) as GenerateContentResponse;
    const candidate = payload.candidates?.[0];

    return {
      content: (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
      finishReason: normalizeFinishReason(candidate?.finishReason),
      usage: {
        promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
      ...(payload.responseId !== undefined && { providerResponseId: payload.responseId }),
    };
  }

  async *chatStream(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    if (this.protocol === 'generate-content') {
      yield* this.streamViaGenerateContent(request, deployment, signal);
      return;
    }

    const response = await fetch(`${this.root}/interactions`, {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: this.interactionsBody(request, deployment, true),
      signal,
    });
    await ensureOk(response, this.provider);

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null || data === '[DONE]') continue;

      const payload = JSON.parse(data) as InteractionsResponse & { type?: string };

      // `step.delta` carries the incremental text; `interaction.completed` the usage.
      const delta = payload.delta?.text ?? '';
      const chunk: ChatChunk = { delta };

      if (payload.usage !== undefined) {
        chunk.usage = readUsage(payload.usage);
        chunk.finishReason = 'stop';
      }
      if (delta !== '' || chunk.usage !== undefined) yield chunk;
    }
  }

  private async *streamViaGenerateContent(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    const response = await fetch(
      `${this.root}/models/${deployment.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: this.headers('text/event-stream'),
        body: this.generateContentBody(request, deployment),
        signal,
      },
    );
    await ensureOk(response, this.provider);

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null || data === '[DONE]') continue;

      const payload = JSON.parse(data) as GenerateContentResponse;
      const candidate = payload.candidates?.[0];
      const chunk: ChatChunk = {
        delta: (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
      };

      const finishReason = normalizeFinishReason(candidate?.finishReason);
      if (candidate?.finishReason !== undefined) chunk.finishReason = finishReason;
      if (payload.usageMetadata !== undefined) {
        chunk.usage = {
          promptTokens: payload.usageMetadata.promptTokenCount ?? 0,
          completionTokens: payload.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
      yield chunk;
    }
  }

  /** Embeddings stay on the classic endpoint; the Interactions API is for generation. */
  async embed(
    input: string[],
    deployment: Deployment,
    signal: AbortSignal,
  ): Promise<EmbeddingsResult> {
    const vectors: number[][] = [];

    for (const text of input) {
      const response = await fetch(`${this.root}/models/${deployment.model}:embedContent`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: `models/${deployment.model}`,
          content: { parts: [{ text }] },
        }),
        signal,
      });
      await ensureOk(response, this.provider);

      const payload = (await response.json()) as EmbedContentResponse;
      vectors.push(payload.embedding?.values ?? payload.embeddings?.[0]?.values ?? []);
    }

    return { vectors, usage: { promptTokens: 0, completionTokens: 0 } };
  }
}

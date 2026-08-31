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
  /**
   * One or more API keys, used in turn.
   *
   * Rotation lives HERE rather than in the alias catalogue because a key is not
   * a routing decision: a deployment is chosen by data zone, cost and model,
   * and two keys for the same project in the same zone are the same
   * deployment. `MODEL_PROVIDERS` is keyed by provider name, so two adapter
   * instances would collide on `gemini` anyway.
   */
  apiKeys: string[];
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

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  /** Opaque reasoning state. It sits beside the call, not inside it. */
  thoughtSignature?: string;
}

interface GenerateContentResponse {
  responseId?: string;
  candidates?: {
    content?: { parts?: GeminiPart[] };
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

/**
 * Reads the calls, with the two things that have to survive the round trip.
 *
 * `thoughtSignature` is required: Gemini answers 400 on the next turn without
 * it. An id is now returned by the API; it is still synthesised when absent,
 * because a `functionResponse` is matched to its call by NAME and older
 * responses carry no id at all.
 */
function readGeminiToolCalls(parts: GeminiPart[] | undefined): ToolCallOutput[] {
  return (parts ?? [])
    .filter((part) => part.functionCall?.name !== undefined && part.functionCall.name !== '')
    .map((part, index) => ({
      id: part.functionCall?.id ?? `call_${index.toString()}`,
      name: part.functionCall?.name ?? '',
      arguments: JSON.stringify(part.functionCall?.args ?? {}),
      ...(part.thoughtSignature !== undefined && { providerState: part.thoughtSignature }),
    }));
}

function toGeminiChunk(
  payload: GenerateContentResponse,
  calls: ToolCallOutput[],
  anyCallsYet: boolean,
): ChatChunk {
  const candidate = payload.candidates?.[0];
  const chunk: ChatChunk = {
    delta: (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
  };

  if (calls.length > 0) chunk.toolCalls = calls;

  if (candidate?.finishReason !== undefined) {
    // Gemini reports STOP even when it asked for a call; the parts are what
    // actually say so, and every consumer branches on `finishReason`.
    chunk.finishReason = anyCallsYet ? 'tool_calls' : normalizeFinishReason(candidate.finishReason);
  }
  if (payload.usageMetadata !== undefined) {
    chunk.usage = {
      promptTokens: payload.usageMetadata.promptTokenCount ?? 0,
      completionTokens: payload.usageMetadata.candidatesTokenCount ?? 0,
    };
  }
  return chunk;
}

function toolsConfig(request: ChatRequestInput): Record<string, unknown> {
  if (request.tools === undefined || request.tools.length === 0) return {};

  return {
    tools: [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.parameters !== undefined && { parameters: tool.parameters }),
        })),
      },
    ],
    ...(request.toolChoice !== undefined && {
      toolConfig: { functionCallingConfig: toFunctionCallingConfig(request.toolChoice) },
    }),
  };
}

function toFunctionCallingConfig(
  choice: NonNullable<ChatRequestInput['toolChoice']>,
): Record<string, unknown> {
  if (choice === 'none') return { mode: 'NONE' };
  if (choice === 'required') return { mode: 'ANY' };
  if (choice === 'auto') return { mode: 'AUTO' };
  return { mode: 'ANY', allowedFunctionNames: [choice.name] };
}

/** A turn becomes one `content`; a tool result becomes a `functionResponse` part. */
function toGeminiContents(turns: ChatMessageInput[]): Record<string, unknown>[] {
  return turns.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name ?? '',
              response: { result: message.content ?? '' },
            },
          },
        ],
      };
    }

    const parts: Record<string, unknown>[] = [];
    if (message.content !== null && message.content !== '') parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({
        functionCall: { name: call.name, args: parseArgs(call.arguments), id: call.id },
        // Echoed verbatim. Gemini rejects the turn without it, and answering
        // without the assistant turn at all makes the model ignore the tool
        // result while still returning 200.
        ...(call.providerState !== undefined && { thoughtSignature: call.providerState }),
      });
    }
    if (parts.length === 0) parts.push({ text: '' });

    return { role: message.role === 'assistant' ? 'model' : 'user', parts };
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  private readonly keys: string[];
  private cursor = 0;

  constructor(private readonly options: GeminiOptions) {
    this.protocol = options.protocol ?? 'interactions';
    this.keys = options.apiKeys.filter((key) => key !== '');
  }

  get configured(): boolean {
    return this.keys.length > 0;
  }

  /**
   * The next key, round robin.
   *
   * Advanced on every outbound call, so a RETRY lands on a different key: a
   * quota is per key, and `POLICIES.INFERENCE` already retries a 429 honouring
   * `Retry-After`. Rotating on each attempt turns that retry into a failover
   * for free, with no extra machinery.
   */
  private nextKey(): string {
    if (this.keys.length === 0) return '';
    const key = this.keys[this.cursor % this.keys.length] ?? '';
    this.cursor += 1;
    return key;
  }

  private headers(accept?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // Key in a header, never in the query string: URLs leak into proxy logs.
      'x-goog-api-key': this.nextKey(),
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
      contents: toGeminiContents(turns),
      ...(system !== undefined && { systemInstruction: { parts: [{ text: system }] } }),
      ...toolsConfig(request),
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
    if (this.protocol === 'generate-content' || usesTools(request)) {
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

    const toolCalls = readGeminiToolCalls(candidate?.content?.parts);

    return {
      content: (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
      // Gemini reports STOP even when it asked for a call; the parts are what
      // actually say so, and every consumer branches on `finishReason`.
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : normalizeFinishReason(candidate?.finishReason),
      usage: {
        promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
      ...(payload.responseId !== undefined && { providerResponseId: payload.responseId }),
      ...(toolCalls.length > 0 && { toolCalls }),
    };
  }

  async *chatStream(
    request: ChatRequestInput,
    deployment: Deployment,
    signal: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    if (this.protocol === 'generate-content' || usesTools(request)) {
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

    let toolCalls: ToolCallOutput[] = [];

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null || data === '[DONE]') continue;

      const payload = JSON.parse(data) as GenerateContentResponse;
      // Gemini sends each `functionCall` whole in one chunk; nothing to rejoin.
      const calls = readGeminiToolCalls(payload.candidates?.[0]?.content?.parts);
      toolCalls = [...toolCalls, ...calls];
      yield toGeminiChunk(payload, calls, toolCalls.length > 0);
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

/**
 * The Interactions API has no published function-calling shape, so a request
 * carrying tools takes the `generateContent` route regardless of the configured
 * protocol. Same model, same deployment, same data zone — only the wire format
 * differs, and guessing at an undocumented one would fail silently instead.
 */
function usesTools(request: ChatRequestInput): boolean {
  return request.tools !== undefined && request.tools.length > 0;
}

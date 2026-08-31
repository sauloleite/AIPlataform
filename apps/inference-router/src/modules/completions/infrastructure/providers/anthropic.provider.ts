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

export interface AnthropicOptions {
  apiKey: string;
  baseUrl: string;
  version: string;
}

interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  id?: string;
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: AnthropicBlock;
  delta?: { type?: string; text?: string; stop_reason?: string; partial_json?: string };
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
      messages: toAnthropicMessages(request.messages),
      ...(system !== '' && { system }),
      ...(request.tools !== undefined &&
        request.tools.length > 0 && {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description !== undefined && { description: tool.description }),
            input_schema: tool.parameters ?? { type: 'object', properties: {} },
          })),
          ...(request.toolChoice !== undefined && {
            tool_choice: toAnthropicToolChoice(request.toolChoice),
          }),
        }),
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
    const toolCalls = (payload.content ?? [])
      .filter((block) => block.type === 'tool_use')
      .map((block, index) => ({
        id: block.id ?? `call_${index.toString()}`,
        name: block.name ?? '',
        arguments: JSON.stringify(block.input ?? {}),
      }));

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
      ...(toolCalls.length > 0 && { toolCalls }),
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
    const blocks = new ToolUseBlocks();

    for await (const line of readSseLines(response)) {
      const data = sseData(line);
      if (data === null) continue;

      const event = JSON.parse(data) as AnthropicStreamEvent;

      if (event.type === 'message_start') {
        promptTokens = event.message?.usage?.input_tokens ?? 0;
      } else if (event.type === 'content_block_start') {
        blocks.open(event);
      } else if (event.type === 'content_block_delta') {
        const text = blocks.absorb(event);
        if (text !== null) yield { delta: text };
      } else if (event.type === 'message_delta') {
        yield finalChunk(event, promptTokens, blocks.drain());
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

/**
 * The `tool_use` blocks of one streamed message.
 *
 * A block opens with its id and name, then its input arrives as JSON text split
 * across events. `index` is what keeps two parallel calls from having their
 * fragments interleaved into each other's arguments.
 */
class ToolUseBlocks {
  private readonly open_ = new Map<number, { id: string; name: string; json: string }>();

  open(event: AnthropicStreamEvent): void {
    if (event.content_block?.type !== 'tool_use') return;
    const index = event.index ?? 0;
    this.open_.set(index, {
      id: event.content_block.id ?? `call_${index.toString()}`,
      name: event.content_block.name ?? '',
      json: '',
    });
  }

  /** Returns the text of a text delta, or null when the delta was arguments. */
  absorb(event: AnthropicStreamEvent): string | null {
    if (event.delta?.type === 'text_delta') return event.delta.text ?? '';
    if (event.delta?.type === 'input_json_delta') {
      const block = this.open_.get(event.index ?? 0);
      if (block !== undefined) block.json += event.delta.partial_json ?? '';
    }
    return null;
  }

  drain(): ToolCallOutput[] {
    return [...this.open_.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => ({
        id: block.id,
        name: block.name,
        arguments: block.json === '' ? '{}' : block.json,
      }));
  }
}

function finalChunk(
  event: AnthropicStreamEvent,
  promptTokens: number,
  toolCalls: ToolCallOutput[],
): ChatChunk {
  return {
    delta: '',
    finishReason: normalizeStopReason(event.delta?.stop_reason),
    usage: { promptTokens, completionTokens: event.usage?.output_tokens ?? 0 },
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}

function toAnthropicToolChoice(
  choice: NonNullable<ChatRequestInput['toolChoice']>,
): Record<string, unknown> {
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'auto') return { type: 'auto' };
  return { type: 'tool', name: choice.name };
}

/**
 * Anthropic has no `tool` role: a result is a `tool_result` block inside a USER
 * message, and a requested call is a `tool_use` block inside the assistant one.
 *
 * Consecutive results are merged into a single user message, because the API
 * rejects a `tool_use` turn that is not answered by one message carrying every
 * matching result.
 */
function toAnthropicMessages(messages: ChatMessageInput[]): Record<string, unknown>[] {
  const out: { role: string; content: Record<string, unknown>[] }[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content ?? '',
      };
      const last = out.at(-1);
      if (last?.role === 'user' && isToolResult(last.content.at(-1))) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    const content: Record<string, unknown>[] = [];
    if (message.content !== null && message.content !== '') {
      content.push({ type: 'text', text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseInput(call.arguments),
      });
    }
    // An empty content array is rejected by the API.
    if (content.length === 0) content.push({ type: 'text', text: '' });

    out.push({ role: message.role, content });
  }

  return out;
}

function isToolResult(block: Record<string, unknown> | undefined): boolean {
  return block?.['type'] === 'tool_result';
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

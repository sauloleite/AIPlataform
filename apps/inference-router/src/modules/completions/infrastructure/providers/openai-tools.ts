import type {
  ChatMessageInput,
  ChatRequestInput,
  ToolCallOutput,
} from '../../application/ports.js';

/**
 * The OpenAI tool-calling wire shape, shared by every provider that speaks it.
 *
 * OpenAI, Ollama's OpenAI-compatible endpoint and most local servers use these
 * exact structures, so the mapping lives once here instead of once per adapter.
 */

export interface OpenAiToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export function toolsBody(request: ChatRequestInput): Record<string, unknown> {
  if (request.tools === undefined || request.tools.length === 0) return {};

  return {
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description !== undefined && { description: tool.description }),
        ...(tool.parameters !== undefined && { parameters: tool.parameters }),
      },
    })),
    ...(request.toolChoice !== undefined && {
      tool_choice:
        typeof request.toolChoice === 'string'
          ? request.toolChoice
          : { type: 'function', function: { name: request.toolChoice.name } },
    }),
  };
}

export function messagesBody(messages: ChatMessageInput[]): Record<string, unknown>[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name !== undefined && { name: message.name }),
    ...(message.toolCallId !== undefined && { tool_call_id: message.toolCallId }),
    ...(message.toolCalls !== undefined &&
      message.toolCalls.length > 0 && {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }),
  }));
}

/** Reads the calls off a complete (non-streamed) response. */
export function readToolCalls(raw: OpenAiToolCall[] | undefined): ToolCallOutput[] {
  if (raw === undefined) return [];
  return raw
    .filter((call) => call.function?.name !== undefined && call.function.name !== '')
    .map((call, index) => ({
      id: call.id ?? `call_${index.toString()}`,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    }));
}

/**
 * Reassembles calls that arrive in fragments.
 *
 * A streamed call is spread over many chunks: the id and the name land on the
 * first, then `arguments` trickles in a few characters at a time. `index` is
 * what ties the fragments together — two parallel calls interleave, so
 * appending in arrival order would splice one call's JSON into the other's.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  add(fragments: OpenAiToolCall[] | undefined): void {
    if (fragments === undefined) return;

    for (const fragment of fragments) {
      const index = fragment.index ?? 0;
      const existing = this.byIndex.get(index) ?? { id: '', name: '', arguments: '' };
      this.byIndex.set(index, {
        id: fragment.id ?? existing.id,
        name: fragment.function?.name ?? existing.name,
        arguments: existing.arguments + (fragment.function?.arguments ?? ''),
      });
    }
  }

  get isEmpty(): boolean {
    return this.byIndex.size === 0;
  }

  /** In `index` order, because that is the order the model asked for them in. */
  drain(): ToolCallOutput[] {
    const calls = [...this.byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id === '' ? `call_${index.toString()}` : call.id,
        name: call.name,
        arguments: call.arguments === '' ? '{}' : call.arguments,
      }))
      .filter((call) => call.name !== '');
    this.byIndex.clear();
    return calls;
  }
}

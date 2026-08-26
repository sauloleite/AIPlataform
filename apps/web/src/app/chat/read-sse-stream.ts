import type {
  ChatUpdate,
  ServedBy,
} from '../../modules/console/application/use-cases/send-chat-message';
import { parseSse } from '../../modules/console/domain/sse';

/**
 * Reads the console's own SSE stream in the browser.
 *
 * The same parser the server uses against the platform: an event boundary is a
 * blank line, not a network chunk, and getting that wrong on either side
 * produces the same class of bug. Sharing it means there is one place to be
 * right.
 *
 * The payload is validated rather than cast. It arrives as `unknown` from JSON,
 * and trusting its shape would put an undefined through to the render.
 */
export async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatUpdate> {
  for await (const event of parseSse(body)) {
    const update = toUpdate(event.data);
    if (update !== null) yield update;
  }
}

function toUpdate(data: unknown): ChatUpdate | null {
  if (typeof data !== 'object' || data === null) return null;
  const candidate = data as Record<string, unknown>;

  if (candidate['kind'] === 'delta' && typeof candidate['content'] === 'string') {
    return { kind: 'delta', content: candidate['content'] };
  }
  if (candidate['kind'] === 'finished' && typeof candidate['content'] === 'string') {
    return {
      kind: 'finished',
      content: candidate['content'],
      servedBy: candidate['servedBy'] as ServedBy,
    };
  }
  if (candidate['kind'] === 'error') {
    return {
      kind: 'error',
      code: typeof candidate['code'] === 'string' ? candidate['code'] : 'internal_error',
      message:
        typeof candidate['message'] === 'string' ? candidate['message'] : 'The request failed.',
    };
  }
  return null;
}

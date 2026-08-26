import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/modules/console/domain/sse';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of parseSse(stream)) events.push(event);
  return events;
}

describe('parseSse', () => {
  it('reads events separated by a blank line', async () => {
    const events = await collect(
      streamOf('event: message.delta\ndata: {"content":"a"}\n\nevent: run.finished\ndata: {}\n\n'),
    );

    expect(events).toEqual([
      { name: 'message.delta', data: { content: 'a' } },
      { name: 'run.finished', data: {} },
    ]);
  });

  it('reassembles an event SPLIT across two network chunks', async () => {
    // The bug this guards: a chunk boundary has nothing to do with an event
    // boundary, and treating them as the same drops or truncates events.
    const events = await collect(streamOf('event: message.delta\nda', 'ta: {"content":"ab"}\n\n'));

    expect(events).toEqual([{ name: 'message.delta', data: { content: 'ab' } }]);
  });

  it('reads two events arriving in ONE chunk', async () => {
    const events = await collect(streamOf('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'));
    expect(events).toHaveLength(2);
  });

  it('ignores the heartbeat comment', async () => {
    // The platform sends `:` every 15 s. Mistaking it for an event would push a
    // blank turn into the transcript.
    const events = await collect(streamOf(': keep-alive\n\nevent: a\ndata: 1\n\n'));
    expect(events).toEqual([{ name: 'a', data: 1 }]);
  });

  it('joins multi-line data the way the SSE spec requires', async () => {
    const events = await collect(streamOf('event: a\ndata: {"x":\ndata: 1}\n\n'));
    expect(events).toEqual([{ name: 'a', data: { x: 1 } }]);
  });

  it('carries the id through, which is what reconnection needs', async () => {
    const events = await collect(streamOf('id: 7\nevent: a\ndata: 1\n\n'));
    expect(events).toEqual([{ name: 'a', data: 1, id: '7' }]);
  });

  it('survives CRLF line endings', async () => {
    const events = await collect(streamOf('event: a\r\ndata: 1\r\n\r\n'));
    expect(events).toEqual([{ name: 'a', data: 1 }]);
  });

  it('hands over non-JSON as raw text rather than dropping the event', async () => {
    const events = await collect(streamOf('event: a\ndata: not json\n\n'));
    expect(events).toEqual([{ name: 'a', data: 'not json' }]);
  });

  it('drops a trailing partial event instead of emitting half of it', async () => {
    const events = await collect(streamOf('event: a\ndata: 1\n\nevent: b\ndata: incom'));
    expect(events).toEqual([{ name: 'a', data: 1 }]);
  });
});

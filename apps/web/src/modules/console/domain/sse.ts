/**
 * A minimal Server-Sent Events parser.
 *
 * Domain, not infrastructure: it opens no socket and calls nothing. It turns a
 * stream of text into events according to a wire format, which is a pure rule --
 * the same category as parsing an amount into micros. That is also what lets the
 * browser and the server share it: an adapter could not cross that boundary.
 *
 * `EventSource` is not an option here: it only issues GET requests and cannot
 * set headers, and this stream is a POST carrying an Authorization header. The
 * parser is small enough that pulling in a dependency for it would cost more
 * than it saves.
 *
 * What it has to get right is that a network chunk has nothing to do with an
 * event boundary: an event can arrive split across two chunks, and two events
 * can arrive in one. So bytes accumulate in a buffer and only a blank line
 * dispatches an event.
 */
export interface SseEvent {
  name: string;
  data: unknown;
  id?: string;
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // CRLF is normalised on the way in. The spec allows \r\n, \n and \r as
      // line breaks, which means the event separator can be \r\n\r\n — and a
      // parser looking only for \n\n would never find a boundary and would sit
      // buffering the whole stream.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const event = parseBlock(block);
        if (event !== null) yield event;

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseEvent | null {
  let name = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    // A line starting with ':' is a comment. The platform sends one as its
    // heartbeat, which must not be mistaken for an event.
    if (line === '' || line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') name = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0) return null;

  const payload = dataLines.join('\n');
  try {
    return { name, data: JSON.parse(payload), ...(id !== undefined && { id }) };
  } catch {
    // Not JSON: hand the raw text over rather than dropping the event, so a
    // protocol change shows up as a visible oddity instead of silence.
    return { name, data: payload, ...(id !== undefined && { id }) };
  }
}

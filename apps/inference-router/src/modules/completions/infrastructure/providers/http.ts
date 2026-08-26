import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

/**
 * A transport error carrying what the resilience policy needs to know:
 * `status` decides whether to retry, `retryAfterMs` decides when.
 */
export class ProviderHttpError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.PROVIDER_UNAVAILABLE;
  readonly status: number;
  readonly retryAfterMs?: number;
  override readonly retryable: boolean;

  constructor(input: { provider: string; status: number; body: string; retryAfterMs?: number }) {
    super(`Provider ${input.provider} responded ${input.status.toString()}`, {
      provider: input.provider,
      upstream_status: input.status,
      // Truncated body: a provider error message can echo back the prompt.
      upstream_body: input.body.slice(0, 300),
    });
    this.status = input.status;
    this.retryable = [408, 429, 500, 502, 503, 504].includes(input.status);
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

/** Converts the `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || header === '') return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export async function ensureOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => '');
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  throw new ProviderHttpError({
    provider,
    status: response.status,
    body,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });
}

/**
 * Reads a `text/event-stream` body line by line.
 *
 * It does not use EventSource because we need control of the AbortSignal, and
 * because the body arrives as a byte stream where an event can be split across
 * chunks.
 */
export async function* readSseLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (body === null) return;

  // Explicit typing: `response.body` arrives as `ReadableStream<any>` in the
  // default lib types, and without this every `read()` propagates `any`.
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== '') yield line;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    // Final line with no trailing newline.
    if (buffer.trim() !== '') yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/** Extracts the payload from a `data: ...` line. `null` when it carries nothing useful. */
export function sseData(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  return payload === '' ? null : payload;
}

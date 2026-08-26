import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

/**
 * Erro de transporte com o que a politica de resiliencia precisa saber:
 * `status` decide se retenta, `retryAfterMs` decide quando.
 */
export class ProviderHttpError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.PROVIDER_UNAVAILABLE;
  readonly status: number;
  readonly retryAfterMs?: number;
  override readonly retryable: boolean;

  constructor(input: { provider: string; status: number; body: string; retryAfterMs?: number }) {
    super(`Provedor ${input.provider} respondeu ${input.status.toString()}`, {
      provider: input.provider,
      upstream_status: input.status,
      // Corpo truncado: mensagem de erro de provedor pode ecoar o prompt.
      upstream_body: input.body.slice(0, 300),
    });
    this.status = input.status;
    this.retryable = [408, 429, 500, 502, 503, 504].includes(input.status);
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

/** Converte o header `Retry-After` (segundos ou data HTTP) em milissegundos. */
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
 * Le um corpo `text/event-stream` linha a linha.
 *
 * Nao usa EventSource porque precisamos do controle do AbortSignal e porque o
 * corpo chega como stream de bytes, com eventos podendo ser partidos entre chunks.
 */
export async function* readSseLines(response: Response): AsyncGenerator<string> {
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
      let newlineIndex = buffer.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== '') yield line;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    // Ultima linha sem quebra final.
    if (buffer.trim() !== '') yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/** Extrai o payload de uma linha `data: ...`. `null` quando nao e dado util. */
export function sseData(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  return payload === '' ? null : payload;
}

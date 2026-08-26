import { UpstreamTimeoutError } from '@aia/errors';

/**
 * Aborta a operacao quando o tempo total estoura.
 *
 * O `AbortSignal` e repassado para a operacao para que ela cancele o socket:
 * um timeout que so descarta a promessa deixa a conexao vazando.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  target: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted === true) {
    throw parentSignal.reason as Error;
  }
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const timeoutError = new UpstreamTimeoutError(target, timeoutMs);
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    // O abort chega na operacao como o proprio reason, mas nem toda biblioteca
    // repassa: se o timer disparou, o erro real e o timeout.
    if (controller.signal.aborted && controller.signal.reason === timeoutError) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

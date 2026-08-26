import { UpstreamTimeoutError } from '@aia/errors';

/**
 * Aborts the operation when the total time budget runs out.
 *
 * The `AbortSignal` is handed to the operation so it can cancel the socket: a
 * timeout that merely discards the promise leaks the connection.
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
    // The abort reaches the operation as the reason itself, but not every
    // library forwards it: if the timer fired, the real error is the timeout.
    if (controller.signal.aborted && controller.signal.reason === timeoutError) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

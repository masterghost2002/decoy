/**
 * Produces the rejection value the platform would use for an aborted request:
 * the signal's own reason when it has one, otherwise a stock AbortError.
 */
export function abortReason(signal?: AbortSignal | null): unknown {
  const reason: unknown = signal?.reason;
  if (reason !== undefined) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Waits `ms`, rejecting early if the caller aborts in the meantime. */
export function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortReason(signal));
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A promise that only ever settles by abort. This is how a hung request is
 * simulated, and leaving it pending is the entire point.
 */
export function hangForever(signal?: AbortSignal | null): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    signal?.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
  });
}

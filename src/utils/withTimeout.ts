/** Promise helpers with hard timeouts — no step may hang forever. */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms = 15_000,
  label = 'This step',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s. Check your connection and try again.`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withTimeoutFn<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms = 15_000,
  label = 'This step',
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s. Check your connection and try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

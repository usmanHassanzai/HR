import { useEffect, useRef } from 'react';

/** Debounced callback — skips the first run when `skipInitial` is true. */
export function useDebouncedEffect(
  effect: () => void | (() => void),
  deps: unknown[],
  delayMs = 1200,
  enabled = true,
) {
  const isFirst = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      effect();
    }, delayMs);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

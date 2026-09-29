import { useEffect, useRef } from 'react';

type HistoryBag = Record<string, unknown>;

function readState(): HistoryBag {
  const st = window.history.state;
  return st && typeof st === 'object' ? { ...(st as HistoryBag) } : {};
}

/**
 * Keep a dashboard "page" (tab id) in sync with the browser / WebView history stack
 * so Back returns to the previous in-app page instead of the marketing homepage.
 */
export function useHistorySyncedTab<T extends string>(
  value: T,
  setValue: (next: T) => void,
  options: {
    key: string;
    enabled?: boolean;
    /** When true, Back past the first page stays on this page (does not leave the SPA). */
    trapAtRoot?: boolean;
  },
): void {
  const { key, enabled = true, trapAtRoot = true } = options;
  const applyingPopRef = useRef(false);
  const seededRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  useEffect(() => {
    if (!enabled) return;

    if (applyingPopRef.current) {
      applyingPopRef.current = false;
      const st = readState();
      if (st[key] !== value) {
        window.history.replaceState({ ...st, [key]: value }, '');
      }
      return;
    }

    const st = readState();
    if (!seededRef.current) {
      seededRef.current = true;
      window.history.replaceState({ ...st, [key]: value }, '');
      return;
    }

    if (st[key] === value) return;
    window.history.pushState({ ...st, [key]: value }, '');
  }, [value, key, enabled]);

  useEffect(() => {
    if (!enabled) return;

    const onPop = (event: PopStateEvent) => {
      const st = event.state && typeof event.state === 'object' ? (event.state as HistoryBag) : null;
      const next = st && typeof st[key] === 'string' ? (st[key] as T) : null;

      if (next != null) {
        if (next !== valueRef.current) {
          applyingPopRef.current = true;
          setValueRef.current(next);
        }
        return;
      }

      if (trapAtRoot) {
        // Prevent leaving the signed-in app for the marketing homepage / prior site.
        window.history.pushState({ ...readState(), [key]: valueRef.current }, '');
      }
    };

    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [enabled, key, trapAtRoot]);
}

/**
 * Push a temporary overlay onto the history stack (employee detail, task board, etc.).
 * Back / Android back dismisses the overlay first.
 */
export function useHistoryOverlay(
  open: boolean,
  onClose: () => void,
  options: { key: string; enabled?: boolean },
): void {
  const { key, enabled = true } = options;
  const pushedRef = useRef(false);
  const closingFromPopRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;

    if (open) {
      if (closingFromPopRef.current) {
        closingFromPopRef.current = false;
        return;
      }
      if (!pushedRef.current) {
        window.history.pushState({ ...readState(), [key]: true }, '');
        pushedRef.current = true;
      }
      return;
    }

    if (pushedRef.current && !closingFromPopRef.current) {
      pushedRef.current = false;
      // Overlay closed from UI — drop the extra history entry without firing pop handlers twice.
      if (readState()[key] === true) {
        window.history.back();
      }
    }
    closingFromPopRef.current = false;
  }, [open, enabled, key]);

  useEffect(() => {
    if (!enabled) return;

    const onPop = (event: PopStateEvent) => {
      if (!pushedRef.current) return;
      const st = event.state && typeof event.state === 'object' ? (event.state as HistoryBag) : null;
      if (st?.[key] === true) return;
      pushedRef.current = false;
      closingFromPopRef.current = true;
      onCloseRef.current();
    };

    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [enabled, key]);
}

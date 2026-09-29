import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { isNativeApp } from './nativePlatform';
import { clearGeoHold } from './attendanceBackgroundSession';

/** Idle time before the portal signs the user out (1 hour). */
export const PORTAL_IDLE_MS = 60 * 60 * 1000;

const LAST_ACTIVITY_KEY = 'scorr-last-activity';

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'pointerdown',
  'keydown',
  'touchstart',
  'click',
  'mousemove',
  'scroll',
];

let lockingSession = false;

function clearAuthStorageSync() {
  try {
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    sessionStorage.removeItem(LAST_ACTIVITY_KEY);
    sessionStorage.removeItem('scorr-browser-epoch');
    localStorage.removeItem('scorr-browser-epoch');
    localStorage.removeItem('scorr-open-tabs');
    localStorage.removeItem('scorr-last-tab-unload');
    sessionStorage.removeItem('scorr-web-tab');
    sessionStorage.removeItem('scorr-tab-id');
    sessionStorage.removeItem('scorr-mfa-ok');
  } catch {
    /* ignore */
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      if (k.startsWith('sb-') || k.includes('auth-token')) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* ignore */
  }
}

export async function lockPortalSession(_options?: { force?: boolean }) {
  if (lockingSession) return;
  lockingSession = true;
  try {
    clearGeoHold();
    clearAuthStorageSync();
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      try {
        await supabase.auth.signOut();
      } catch {
        /* ignore */
      }
    }
  } finally {
    lockingSession = false;
  }
}

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return n;
    const now = Date.now();
    writeLastActivity(now);
    return now;
  } catch {
    return Date.now();
  }
}

function writeLastActivity(ts = Date.now()) {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(ts));
  } catch {
    /* ignore */
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type || 'text';
    return !['button', 'submit', 'checkbox', 'radio', 'file', 'reset', 'image', 'range', 'color'].includes(type);
  }
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/**
 * Auto-logout only after true idle (PORTAL_IDLE_MS) with no input.
 *
 * Refresh / tab switch / page reload must NOT sign out — browsers fire the same
 * unload events for refresh as for close, so we never clear the session on unload.
 * Native: when returning to the app, expire only if the idle window already passed.
 */
export function usePortalSessionGuard(enabled: boolean, options?: { idle?: boolean }) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const idleEnabled = options?.idle ?? enabled;
  const idleRef = useRef(idleEnabled);
  idleRef.current = idleEnabled;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const remainingMs = () => Math.max(0, PORTAL_IDLE_MS - (Date.now() - readLastActivity()));

    const armIdleTimer = () => {
      if (!idleRef.current) {
        clearTimer();
        return;
      }
      clearTimer();
      const wait = remainingMs() || PORTAL_IDLE_MS;
      timerRef.current = window.setTimeout(() => {
        if (!enabledRef.current || !idleRef.current) return;
        if (Date.now() - readLastActivity() >= PORTAL_IDLE_MS) {
          void lockPortalSession();
          return;
        }
        armIdleTimer();
      }, wait);
    };

    const expireIfIdle = () => {
      if (!enabledRef.current || !idleRef.current) return;
      if (Date.now() - readLastActivity() >= PORTAL_IDLE_MS) {
        void lockPortalSession();
        return;
      }
      armIdleTimer();
    };

    const onActivity = () => {
      if (!enabledRef.current) return;
      writeLastActivity();
      armIdleTimer();
    };

    // Block Backspace from navigating browser history when focus is not in a field
    // (avoids wiping the current Assign Task / form page).
    const onBackspaceNav = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'BrowserBack') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
    };

    writeLastActivity();
    if (idleEnabled) armIdleTimer();

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Coming back to the tab is not idle by itself — only expire if timer already elapsed.
      expireIfIdle();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', expireIfIdle);
    window.addEventListener('keydown', onBackspaceNav, true);

    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_ACTIVITY_KEY) armIdleTimer();
    };
    window.addEventListener('storage', onStorage);

    let appStateHandle: { remove: () => Promise<void> } | null = null;
    if (isNativeApp()) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (!enabledRef.current) return;
        if (isActive) {
          // Returning to the app — logout only if they were idle long enough.
          expireIfIdle();
        }
        // Do not sign out merely for backgrounding; refresh/resume must keep the session.
      }).then((h) => {
        appStateHandle = h;
      });
    }

    return () => {
      clearTimer();
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', expireIfIdle);
      window.removeEventListener('keydown', onBackspaceNav, true);
      window.removeEventListener('storage', onStorage);
      void appStateHandle?.remove();
    };
  }, [enabled, idleEnabled]);
}

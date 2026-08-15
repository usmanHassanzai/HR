import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { isNativeApp } from './nativePlatform';

/** Idle time before the portal signs the user out. */
export const PORTAL_IDLE_MS = 20 * 60 * 1000;
const LAST_ACTIVITY_KEY = 'scorr-last-activity';

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'pointerdown',
  'keydown',
  'touchstart',
  'scroll',
  'click',
];

let lockingSession = false;

function clearAuthStorageSync() {
  try {
    sessionStorage.removeItem(LAST_ACTIVITY_KEY);
    localStorage.removeItem(LAST_ACTIVITY_KEY);
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

export async function lockPortalSession() {
  if (lockingSession) return;
  lockingSession = true;
  clearAuthStorageSync();
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    try {
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
  } finally {
    lockingSession = false;
  }
}

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : Date.now();
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

/**
 * Auto-logout after 20 minutes idle.
 * Switching browser tabs, hiding the page, or switching apps does not log out.
 */
export function usePortalSessionGuard(enabled: boolean) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
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
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        if (enabledRef.current) void lockPortalSession();
      }, remainingMs() || PORTAL_IDLE_MS);
    };

    const expireIfIdle = () => {
      if (!enabledRef.current) return;
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

    writeLastActivity();
    expireIfIdle();

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') expireIfIdle();
    };
    document.addEventListener('visibilitychange', onVisible);

    let appStateHandle: { remove: () => Promise<void> } | null = null;
    if (isNativeApp()) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) expireIfIdle();
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
      void appStateHandle?.remove();
    };
  }, [enabled]);
}

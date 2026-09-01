import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { isNativeApp } from './nativePlatform';
import { clearGeoHold } from './attendanceBackgroundSession';

/** Idle time before the portal signs the user out. */
export const PORTAL_IDLE_MS = 20 * 60 * 1000;

const LAST_ACTIVITY_KEY = 'scorr-last-activity';
const TABS_KEY = 'scorr-open-tabs';
const TAB_ID_KEY = 'scorr-tab-id';
const CONTINUING_TAB_KEY = 'scorr-web-tab';
const LAST_UNLOAD_KEY = 'scorr-last-tab-unload';
const TAB_TTL_MS = 75_000;
const TAB_HEARTBEAT_MS = 20_000;

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'pointerdown',
  'keydown',
  'touchstart',
  'click',
  'mousemove',
  'scroll',
];

type TabRecord = { id: string; seen: number };

let lockingSession = false;
let thisTabId: string | null = null;

function clearAuthStorageSync() {
  try {
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    sessionStorage.removeItem(LAST_ACTIVITY_KEY);
    sessionStorage.removeItem('scorr-browser-epoch');
    localStorage.removeItem('scorr-browser-epoch');
    localStorage.removeItem(TABS_KEY);
    localStorage.removeItem(LAST_UNLOAD_KEY);
    sessionStorage.removeItem(CONTINUING_TAB_KEY);
    sessionStorage.removeItem(TAB_ID_KEY);
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

function readTabs(): TabRecord[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TabRecord[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((t) => t && typeof t.id === 'string' && now - t.seen < TAB_TTL_MS);
  } catch {
    return [];
  }
}

function writeTabs(tabs: TabRecord[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* ignore */
  }
}

function hasLiveTabs(exceptId?: string | null): boolean {
  return readTabs().some((t) => t.id !== exceptId);
}

function ensureTabId(): string {
  if (thisTabId) return thisTabId;
  thisTabId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return thisTabId;
}

function markContinuingTab() {
  try {
    sessionStorage.setItem(CONTINUING_TAB_KEY, '1');
    sessionStorage.setItem(TAB_ID_KEY, ensureTabId());
  } catch {
    /* ignore */
  }
}

function isContinuingTab(): boolean {
  try {
    return sessionStorage.getItem(CONTINUING_TAB_KEY) === '1';
  } catch {
    return false;
  }
}

function registerOpenTab() {
  if (isNativeApp()) return;
  const id = ensureTabId();
  markContinuingTab();
  const now = Date.now();
  const others = readTabs().filter((t) => t.id !== id);
  writeTabs([...others, { id, seen: now }]);
  try {
    localStorage.removeItem(LAST_UNLOAD_KEY);
  } catch {
    /* ignore */
  }
}

function unregisterOpenTab() {
  if (isNativeApp()) return;
  const id = thisTabId ?? ensureTabId();
  const remaining = readTabs().filter((t) => t.id !== id);
  writeTabs(remaining);
  if (remaining.length === 0) {
    try {
      localStorage.setItem(LAST_UNLOAD_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  }
}

/** True when the last Scorr browser tab was closed (not a refresh or tab switch). */
function shouldLogoutAfterClosedTabs(): boolean {
  if (typeof window === 'undefined' || isNativeApp()) return false;
  if (isContinuingTab()) return false;
  if (hasLiveTabs()) return false;
  try {
    return Boolean(localStorage.getItem(LAST_UNLOAD_KEY));
  } catch {
    return false;
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

function logoutAfterClosedTabsSync() {
  if (!shouldLogoutAfterClosedTabs()) return;
  clearGeoHold();
  clearAuthStorageSync();
  void supabase.auth.signOut({ scope: 'local' }).catch(() => {
    /* ignore */
  });
}

if (typeof window !== 'undefined') {
  logoutAfterClosedTabsSync();
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

/**
 * Stay signed in while switching browser tabs or in-app tabs.
 * Sign out after 20 minutes idle, or when the last Scorr web tab is closed.
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

    registerOpenTab();

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

    if (idleEnabled) expireIfIdle();

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      registerOpenTab();
      expireIfIdle();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', expireIfIdle);

    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_ACTIVITY_KEY) armIdleTimer();
    };
    window.addEventListener('storage', onStorage);

    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      unregisterOpenTab();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) registerOpenTab();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    let heartbeat: number | null = null;
    if (!isNativeApp()) {
      heartbeat = window.setInterval(() => {
        if (enabledRef.current) registerOpenTab();
      }, TAB_HEARTBEAT_MS);
    }

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
      if (heartbeat != null) window.clearInterval(heartbeat);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', expireIfIdle);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      void appStateHandle?.remove();
    };
  }, [enabled, idleEnabled]);
}

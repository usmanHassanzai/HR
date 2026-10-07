import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { isNativeApp } from './nativePlatform';
import { clearGeoHold } from './attendanceBackgroundSession';
import {
  hasAssignedShiftEnded,
  isWithinAssignedShift,
  locationWindowToMyShift,
  msUntilAssignedShiftEnd,
  type LocationWindow,
} from './shiftHelpers';

/**
 * Absolute portal session lifetime from login (not idle / sliding).
 * Refresh tokens may renew JWTs inside this window; at 1 hour the client
 * forcibly signs out on web, Capacitor, and Electron.
 */
export const PORTAL_SESSION_MAX_MS = 60 * 60 * 1000;

/** @deprecated Use PORTAL_SESSION_MAX_MS — kept for any older imports. */
export const PORTAL_IDLE_MS = PORTAL_SESSION_MAX_MS;

const SESSION_STARTED_KEY = 'scorr-session-started-at';
const AUTH_NOTICE_KEY = 'scorr-auth-notice';
const SHIFT_SESSION_KEY = 'scorr-shift-session';

export type AuthNotice = 'session_expired' | 'shift_ended';

let lockingSession = false;

function clearAuthStorageSync() {
  try {
    localStorage.removeItem(SESSION_STARTED_KEY);
    sessionStorage.removeItem(SESSION_STARTED_KEY);
    sessionStorage.removeItem('scorr-browser-epoch');
    localStorage.removeItem('scorr-browser-epoch');
    localStorage.removeItem('scorr-open-tabs');
    localStorage.removeItem('scorr-last-tab-unload');
    sessionStorage.removeItem('scorr-web-tab');
    sessionStorage.removeItem('scorr-tab-id');
    sessionStorage.removeItem('scorr-mfa-ok');
    sessionStorage.removeItem(SHIFT_SESSION_KEY);
    // Legacy idle key from pre-1.3.7 sliding timeout
    localStorage.removeItem('scorr-last-activity');
    sessionStorage.removeItem('scorr-last-activity');
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

function setAuthNotice(notice: AuthNotice) {
  try {
    sessionStorage.setItem(AUTH_NOTICE_KEY, notice);
  } catch {
    /* ignore */
  }
}

/** Consume one-shot banner after forced logout (login / landing). */
export function consumeAuthNotice(): AuthNotice | null {
  try {
    const v = sessionStorage.getItem(AUTH_NOTICE_KEY);
    sessionStorage.removeItem(AUTH_NOTICE_KEY);
    if (v === 'session_expired' || v === 'shift_ended') return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function authNoticeMessage(notice: AuthNotice): string {
  if (notice === 'shift_ended') {
    return 'Your shift ended, so you were signed out. Sign in again to continue.';
  }
  return 'Your session expired after 1 hour. Please sign in again.';
}

/** Record login time. Pass reset=true on fresh SIGNED_IN. */
export function markPortalSessionStart(reset = false) {
  try {
    if (!reset && localStorage.getItem(SESSION_STARTED_KEY)) return;
    localStorage.setItem(SESSION_STARTED_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function readPortalSessionStartedAt(): number | null {
  try {
    const raw = localStorage.getItem(SESSION_STARTED_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function portalSessionRemainingMs(): number {
  const started = readPortalSessionStartedAt();
  if (started == null) return PORTAL_SESSION_MAX_MS;
  return Math.max(0, PORTAL_SESSION_MAX_MS - (Date.now() - started));
}

export function isPortalSessionExpired(): boolean {
  const started = readPortalSessionStartedAt();
  if (started == null) return false;
  return Date.now() - started >= PORTAL_SESSION_MAX_MS;
}

/**
 * Sign out locally, clear Supabase auth persistence.
 * Does NOT clear remember-me credentials or device-token auto attendance.
 */
export async function lockPortalSession(options?: { force?: boolean; reason?: AuthNotice }) {
  if (lockingSession) return;
  lockingSession = true;
  try {
    if (options?.reason) setAuthNotice(options.reason);
    clearGeoHold();
    // R32: shift-end / session lock must NOT stop device-token auto attendance.
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

function markShiftSession() {
  try {
    sessionStorage.setItem(SHIFT_SESSION_KEY, '1');
  } catch {
    /* ignore */
  }
}

function hadShiftSession(): boolean {
  try {
    return sessionStorage.getItem(SHIFT_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Auto-logout when the assigned shift (or company office window) ends.
 * After-hours logins are not kicked immediately — only sessions that were
 * active during the shift window.
 */
export function useShiftEndSessionLogout(enabled: boolean) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let endTimer: number | null = null;
    let pollId: number | null = null;

    const clearEndTimer = () => {
      if (endTimer != null) {
        window.clearTimeout(endTimer);
        endTimer = null;
      }
    };

    const logoutForShiftEnd = async () => {
      if (cancelled || !enabledRef.current) return;
      await lockPortalSession({ force: true, reason: 'shift_ended' });
    };

    const sync = async () => {
      if (cancelled || !enabledRef.current) return;
      try {
        const { data, error } = await supabase.rpc('get_my_location_window');
        if (error || !data || cancelled) return;
        const win = data as LocationWindow;
        if (!win?.start_time || !win?.end_time) return;
        const shift = locationWindowToMyShift(win);

        if (isWithinAssignedShift(shift)) {
          markShiftSession();
          clearEndTimer();
          const wait = Math.min(Math.max(msUntilAssignedShiftEnd(shift) + 2_000, 5_000), 12 * 60 * 60 * 1000);
          endTimer = window.setTimeout(() => {
            void logoutForShiftEnd();
          }, wait);
          return;
        }

        if (hasAssignedShiftEnded(shift) && hadShiftSession()) {
          clearEndTimer();
          await logoutForShiftEnd();
        }
      } catch {
        /* network — retry on next poll */
      }
    };

    void sync();
    pollId = window.setInterval(() => {
      void sync();
    }, 60_000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearEndTimer();
      if (pollId != null) window.clearInterval(pollId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
}

/**
 * Absolute 1-hour session from login across web, Capacitor, and Electron.
 * Activity does not extend the session. Token refresh is allowed only while
 * inside the window; past 1 hour the client signs out and returns to login.
 */
export function usePortalSessionGuard(enabled: boolean, _options?: { idle?: boolean }) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    markPortalSessionStart(false);

    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const expireNow = () => {
      if (!enabledRef.current) return;
      void lockPortalSession({ force: true, reason: 'session_expired' });
    };

    const armAbsoluteTimer = () => {
      clearTimer();
      if (!enabledRef.current) return;
      if (isPortalSessionExpired()) {
        expireNow();
        return;
      }
      const wait = Math.max(1_000, portalSessionRemainingMs());
      timerRef.current = window.setTimeout(() => {
        if (!enabledRef.current) return;
        if (isPortalSessionExpired()) {
          expireNow();
          return;
        }
        armAbsoluteTimer();
      }, wait);
    };

    const checkExpiry = () => {
      if (!enabledRef.current) return;
      if (isPortalSessionExpired()) {
        expireNow();
        return;
      }
      armAbsoluteTimer();
    };

    // Block Backspace from navigating browser history when focus is not in a field.
    const onBackspaceNav = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'BrowserBack') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
    };

    armAbsoluteTimer();

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkExpiry();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', checkExpiry);
    window.addEventListener('keydown', onBackspaceNav, true);

    const onStorage = (e: StorageEvent) => {
      if (e.key === SESSION_STARTED_KEY) armAbsoluteTimer();
    };
    window.addEventListener('storage', onStorage);

    let appStateHandle: { remove: () => Promise<void> } | null = null;
    if (isNativeApp()) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (!enabledRef.current) return;
        if (isActive) checkExpiry();
      }).then((h) => {
        appStateHandle = h;
      });
    }

    // Periodic check covers Background tabs / suspended timers.
    const pollId = window.setInterval(() => {
      if (!enabledRef.current) return;
      if (isPortalSessionExpired()) expireNow();
    }, 30_000);

    return () => {
      clearTimer();
      window.clearInterval(pollId);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', checkExpiry);
      window.removeEventListener('keydown', onBackspaceNav, true);
      window.removeEventListener('storage', onStorage);
      void appStateHandle?.remove();
    };
  }, [enabled]);
}

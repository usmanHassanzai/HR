import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { isNativeApp } from './nativePlatform';
import { clearGeoHold } from './attendanceBackgroundSession';

/**
 * Sign out after one hour without use. Activity resets the hour.
 * Shift start and end do not sign anyone out. Web, phone, and desktop share this rule.
 */
export const PORTAL_SESSION_MAX_MS = 60 * 60 * 1000;

/** @deprecated Use PORTAL_SESSION_MAX_MS — kept for any older imports. */
export const PORTAL_IDLE_MS = PORTAL_SESSION_MAX_MS;

const SESSION_STARTED_KEY = 'scorr-session-started-at';
const LAST_ACTIVITY_KEY = 'scorr-last-activity';
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
    localStorage.removeItem(LAST_ACTIVITY_KEY);
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
  return 'You were signed out after 1 hour without use. Please sign in again.';
}

/** Record that the person is using the app. Throttled unless force is set. */
export function touchPortalActivity(force = false) {
  try {
    const now = Date.now();
    if (!force) {
      const prev = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
      if (Number.isFinite(prev) && now - prev < 15_000) return;
    }
    localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  } catch {
    /* ignore */
  }
}

/** Record login time. Pass reset=true on fresh SIGNED_IN. Also starts the idle hour. */
export function markPortalSessionStart(reset = false) {
  try {
    if (reset || !localStorage.getItem(SESSION_STARTED_KEY)) {
      localStorage.setItem(SESSION_STARTED_KEY, String(Date.now()));
    }
    if (reset || !localStorage.getItem(LAST_ACTIVITY_KEY)) {
      touchPortalActivity(true);
    }
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

function readLastActivityAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function portalSessionRemainingMs(): number {
  const last = readLastActivityAt();
  if (last == null) return PORTAL_SESSION_MAX_MS;
  return Math.max(0, PORTAL_SESSION_MAX_MS - (Date.now() - last));
}

export function isPortalSessionExpired(): boolean {
  const last = readLastActivityAt();
  if (last == null) return false;
  return Date.now() - last >= PORTAL_SESSION_MAX_MS;
}

/**
 * Sign out locally, clear Supabase auth persistence.
 * Does NOT clear remember-me credentials (Keystore/Keychain/safeStorage/IndexedDB vault)
 * or device-token auto attendance. Explicit Sign out & forget clears those separately.
 */
export async function lockPortalSession(options?: { force?: boolean; reason?: AuthNotice }) {
  if (lockingSession) return;
  lockingSession = true;
  try {
    if (options?.reason) setAuthNotice(options.reason);
    clearGeoHold();
    // R32: shift-end / session lock must NOT stop device-token auto attendance.
    // Remember-me: never call clearRememberedLogin / clearLoginCredentials here.
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

/** Shift end must not sign anyone out. Login stays valid during and outside the shift. */
export function useShiftEndSessionLogout(_enabled: boolean) {
  return;
}

/**
 * Sign out after one hour without use on web, phone, and desktop.
 * Clicks, typing, and scrolling start the hour again. Shift times do not.
 */
export function usePortalSessionGuard(enabled: boolean, _options?: { idle?: boolean }) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    markPortalSessionStart(false);
    touchPortalActivity(true);

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

    const onActivity = () => {
      if (!enabledRef.current) return;
      if (isPortalSessionExpired()) {
        expireNow();
        return;
      }
      touchPortalActivity(false);
      armAbsoluteTimer();
    };

    armAbsoluteTimer();

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkExpiry();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', checkExpiry);
    window.addEventListener('pointerdown', onActivity, true);
    window.addEventListener('keydown', onActivity, true);
    window.addEventListener('scroll', onActivity, true);
    window.addEventListener('touchstart', onActivity, true);
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
      window.removeEventListener('pointerdown', onActivity, true);
      window.removeEventListener('keydown', onActivity, true);
      window.removeEventListener('scroll', onActivity, true);
      window.removeEventListener('touchstart', onActivity, true);
      window.removeEventListener('keydown', onBackspaceNav, true);
      window.removeEventListener('storage', onStorage);
      void appStateHandle?.remove();
    };
  }, [enabled]);
}

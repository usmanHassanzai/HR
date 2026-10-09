/**
 * Web browser tab + iOS Home Screen cannot keep sending after close.
 * On hide/pagehide, send app_backgrounded via sendBeacon so the server
 * holds Rule 5b/5c for attendance_backgrounded_minutes (default 60).
 * Native Capacitor / desktop tray must NOT send this — they keep tracking.
 */
import { Capacitor } from '@capacitor/core';
import { isDesktopApp, clientAttendancePlatform } from './nativePlatform';
import { getAttendanceDeviceToken } from './attendanceDevice';

const TOKEN_CACHE_KEY = 'scorr_att_beacon_token';
const DEVICE_CACHE_KEY = 'scorr_att_beacon_device_id';

let bound = false;
let lastSentAt = 0;

function canUseBackgroundedEvent(): boolean {
  if (typeof window === 'undefined') return false;
  if (Capacitor.isNativePlatform()) return false;
  if (isDesktopApp()) return false;
  // Browser tab or iOS Home Screen web app only
  return true;
}

function cacheSync(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readSync(key: string): string | null {
  try {
    const s = sessionStorage.getItem(key);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keep token/device id readable synchronously for sendBeacon on pagehide. */
export async function warmAppBackgroundedBeaconCache(): Promise<void> {
  if (!canUseBackgroundedEvent()) return;
  const token = await getAttendanceDeviceToken();
  if (!token) return;
  cacheSync(TOKEN_CACHE_KEY, token);
  let deviceId = readSync(DEVICE_CACHE_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    cacheSync(DEVICE_CACHE_KEY, deviceId);
  }
}

function sendAppBackgroundedBeacon(): void {
  if (!canUseBackgroundedEvent()) return;
  const token = readSync(TOKEN_CACHE_KEY);
  if (!token) return;
  const now = Date.now();
  if (now - lastSentAt < 5_000) return;
  lastSentAt = now;

  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '';
  if (!supabaseUrl || !anon) return;

  const body = JSON.stringify({
    device_token: token,
    event: 'app_backgrounded',
    occurred_at_utc_ms: now,
    device_now_utc_ms: now,
    device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    device_id: readSync(DEVICE_CACHE_KEY) || crypto.randomUUID(),
    platform: clientAttendancePlatform(),
    app_version: '1.3.19',
  });

  const url = `${supabaseUrl}/functions/v1/auto-attendance-event`;
  // Prefer fetch+keepalive so apikey / x-device-token headers are sent.
  // sendBeacon is the fallback (body includes device_token).
  try {
    void fetch(url, {
      method: 'POST',
      headers: {
        apikey: anon,
        'Content-Type': 'application/json',
        'x-device-token': token,
      },
      body,
      keepalive: true,
      credentials: 'omit',
    });
    return;
  } catch {
    /* fall through */
  }

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    }
  } catch {
    /* ignore */
  }
}

function onVisibilityOrHide(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    sendAppBackgroundedBeacon();
  }
}

function onPageHide(): void {
  sendAppBackgroundedBeacon();
}

/**
 * Bind once for web tab / iOS Home Screen when a device token is enrolled.
 * No-op on Android/iOS Capacitor and desktop.
 */
export function bindAppBackgroundedReporter(): void {
  if (bound || typeof document === 'undefined') return;
  if (!canUseBackgroundedEvent()) return;
  bound = true;
  void warmAppBackgroundedBeaconCache();
  document.addEventListener('visibilitychange', onVisibilityOrHide);
  window.addEventListener('pagehide', onPageHide);
}

/** Call when Home Screen / web attendance starts so the cache is warm. */
export async function startAppBackgroundedReporter(): Promise<void> {
  if (!canUseBackgroundedEvent()) return;
  await warmAppBackgroundedBeaconCache();
  bindAppBackgroundedReporter();
}

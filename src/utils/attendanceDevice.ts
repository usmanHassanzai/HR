/**
 * Automatic attendance device enrollment + schedule helpers (R28–R34).
 * Token never expires; stored in Capacitor Preferences (native Keystore/Keychain
 * backed storage on mobile) / localStorage fallback for Electron preload bridge.
 */
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../lib/supabase';
import { supabaseUrl, supabaseAnonKey } from '../lib/supabaseConfig';
import { isNativeApp, isDesktopApp, isIosHomeScreen, clientAttendancePlatform } from './nativePlatform';

const TOKEN_KEY = 'scorr_attendance_device_token';
const DEVICE_ID_KEY = 'scorr_attendance_device_id';

export const PHONE_OPT_IN_TEXT =
  'Enable once: allow location (All the time), notifications, Wi‑Fi, and unrestricted battery. After that Scorr checks you in on office Wi‑Fi or inside the office radius during your shift — no daily login needed. Public Wi‑Fi does not count.';

export const LAPTOP_OPT_IN_TEXT =
  'Enable once: allow location if asked, keep the tray icon running, and turn on start at login. After that this computer checks you in on office Wi‑Fi or inside the office radius during your shift — no daily dashboard login needed. Public Wi‑Fi does not count.';

/** Map raw Supabase / Postgres errors to short user-facing copy. */
export function friendlyAutoAttendanceError(raw: unknown, fallback?: string): string {
  const msg = (raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '') || '';
  const lower = msg.toLowerCase();

  if (
    lower.includes('attendance_devices_user_id_device_id_key') ||
    (lower.includes('duplicate key') && lower.includes('attendance_devices'))
  ) {
    return 'This device is already registered — refreshing…';
  }
  if (lower.includes('not authenticated') || lower.includes('jwt')) {
    return 'Please sign in again, then try enabling automatic check-in.';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('failed to fetch')) {
    return 'Connection timed out. Check your network and try again.';
  }
  if (lower.includes('platform_disabled') || lower.includes('not available on ios')) {
    return msg.trim() || 'Automatic check-in needs the Android app or desktop app.';
  }
  // Hide constraint names, SQLSTATE, stack-like detail
  if (
    /violates unique constraint|duplicate key value|sqlstate|postgres|stack|exception/i.test(msg) ||
    msg.length > 180
  ) {
    return fallback || 'Couldn’t enable automatic check-in. Try again.';
  }
  if (!msg.trim()) {
    return fallback || 'Couldn’t enable automatic check-in. Try again.';
  }
  return msg.trim();
}

async function secureGet(key: string): Promise<string | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { value } = await Preferences.get({ key });
      return value;
    }
  } catch {
    /* fall through */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      await Preferences.set({ key, value });
      return;
    }
  } catch {
    /* fall through */
  }
  localStorage.setItem(key, value);
}

async function secureRemove(key: string): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      await Preferences.remove({ key });
    }
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export async function getAttendanceDeviceToken(): Promise<string | null> {
  return secureGet(TOKEN_KEY);
}

function detectPlatform(): 'android' | 'ios' | 'windows' | 'linux' | 'web' {
  return clientAttendancePlatform();
}

async function ensureDeviceId(): Promise<string> {
  let id = await secureGet(DEVICE_ID_KEY);
  if (id) return id;
  id = crypto.randomUUID();
  await secureSet(DEVICE_ID_KEY, id);
  return id;
}

export async function registerAttendanceDevice(appVersion?: string): Promise<{
  ok: boolean;
  device_token?: string;
  error?: string;
}> {
  // Prefer direct RPC (JWT) — edge function historically hit BOOT_ERROR and hung clients with no timeout.
  const { registerDeviceViaRpc } = await import('./autoAttendanceSetup');
  return registerDeviceViaRpc(appVersion || '1.3.7');
}

/** Clear local token + stop desktop heartbeat / Android FGS. Safe to call repeatedly. */
export async function clearLocalAttendanceEnrollment(): Promise<void> {
  await secureRemove(TOKEN_KEY);
  try {
    const clear = (
      window as unknown as {
        scorrDesktop?: { clearAttendanceToken?: () => Promise<boolean> | boolean | void };
      }
    ).scorrDesktop?.clearAttendanceToken;
    if (clear) await Promise.resolve(clear());
  } catch {
    /* ignore */
  }
  try {
    const { stopNativeAttendancePings } = await import('./attendanceNativePing');
    await stopNativeAttendancePings();
  } catch {
    /* ignore */
  }
  try {
    const { stopIosHomeAttendance } = await import('./attendanceIosHome');
    stopIosHomeAttendance();
  } catch {
    /* ignore */
  }
}

export async function disableAutoAttendanceOnDevice(kind: 'phone' | 'laptop' = 'phone'): Promise<void> {
  try {
    await supabase.rpc('disable_my_auto_attendance', { p_kind: kind });
  } finally {
    // Always drop local enrollment so UI can show Enable again even if RPC fails.
    await clearLocalAttendanceEnrollment();
  }
}

export async function fetchAttendanceSchedule(): Promise<Record<string, unknown> | null> {
  const token = await getAttendanceDeviceToken();
  // Prefer device-token edge after enroll. Fall back to JWT RPC when no token yet.
  if (!token || !supabaseUrl || !supabaseAnonKey) {
    const { data, error } = await supabase.rpc('get_my_attendance_schedule');
    if (error) return { ok: false, reason: error.message };
    return data as Record<string, unknown> | null;
  }
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/attendance-schedule`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
        'x-device-token': token,
      },
      body: JSON.stringify({ device_token: token }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return body ?? { ok: false, reason: `schedule_http_${res.status}` };
    }
    return body;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'schedule_fetch_failed',
    };
  }
}

export async function sendAutoAttendanceEvent(
  event: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const token = await getAttendanceDeviceToken();
  if (!token || !supabaseUrl || !supabaseAnonKey) return null;

  const { isAttendanceEventFresh, logStaleAttendanceDrop } = await import('./attendanceStaleQueue');
  const now = Date.now();
  const occurredRaw = extra.occurred_at_utc_ms;
  const occurred =
    typeof occurredRaw === 'number' && Number.isFinite(occurredRaw) ? occurredRaw : now;
  if (!isAttendanceEventFresh(occurred, now)) {
    logStaleAttendanceDrop({
      source: 'web-auto-event',
      event,
      age_ms: now - occurred,
      occurred_at_utc_ms: occurred,
    });
    return { ok: false, reason: 'event_too_old', action: 'event_too_old', client_dropped: true };
  }

  const body = {
    device_token: token,
    event,
    occurred_at_utc_ms: occurred,
    device_now_utc_ms: now,
    device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    device_id: await ensureDeviceId(),
    platform: detectPlatform(),
    ...extra,
  };

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/auto-attendance-event`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
        'x-device-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return {
      ok: false,
      reason: 'no_connection',
      action: 'no_connection',
      message: 'No connection - will check when online',
    };
  }
}

/** Laptop and Test now: attach GPS when available + Wi-Fi; soft-fail GPS for Wi-Fi-only check-in. */
export async function sendAutoAttendanceEventWithLocation(
  event: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const { requestCurrentPosition, probeDeviceWifiIdentity } = await import('./geoAttendance');
  const readFix = async () => {
    const pos = await requestCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy_m: pos.coords.accuracy ?? null,
    };
  };

  const [fixSettled, wifi] = await Promise.all([
    readFix().then(
      (f) => f,
      () => ({} as Record<string, unknown>),
    ),
    probeDeviceWifiIdentity().catch(() => ({
      ssid: null as string | null,
      bssid: null as string | null,
      probed: false,
    })),
  ]);
  let fix: Record<string, unknown> = fixSettled;
  const wifiExtra: Record<string, unknown> = {};
  if (wifi.ssid) wifiExtra.ssid = wifi.ssid;
  if (wifi.bssid) wifiExtra.bssid = wifi.bssid;

  let res = await sendAutoAttendanceEvent(event, { ...extra, ...wifiExtra, ...fix });
  if (res?.action === 'need_fresh_location') {
    try {
      fix = await readFix();
      res = await sendAutoAttendanceEvent(event, { ...extra, ...wifiExtra, ...fix });
    } catch {
      /* keep the server reason — Wi-Fi/IP may still have matched on the first call */
    }
  }
  return res;
}

export function isAutoAttendanceClient(): boolean {
  return isNativeApp() || isDesktopApp() || isIosHomeScreen();
}

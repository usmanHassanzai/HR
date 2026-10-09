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
  'After this one-time setup, Scorr checks you in on office Wi-Fi during your shift window. If location is on and accurate, you must also be inside the office radius. If location is off, office Wi-Fi alone is enough to check in. Check-in runs from 1 hour before your shift until the shift ends.';

export const LAPTOP_OPT_IN_TEXT =
  'This laptop checks in on office Wi-Fi during your shift window. If location is on and accurate, you must also be inside the office radius. If location is off or weak, office Wi-Fi alone is enough to check in. Shutting the laptop down does not check you out.';

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
  return registerDeviceViaRpc(appVersion || '1.3.17');
}

export async function disableAutoAttendanceOnDevice(kind: 'phone' | 'laptop' = 'phone'): Promise<void> {
  await supabase.rpc('disable_my_auto_attendance', { p_kind: kind });
  await secureRemove(TOKEN_KEY);
  if (kind === 'phone') {
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
}

export async function fetchAttendanceSchedule(): Promise<Record<string, unknown> | null> {
  const token = await getAttendanceDeviceToken();
  if (!token || !supabaseUrl || !supabaseAnonKey) {
    const { data } = await supabase.rpc('get_my_attendance_schedule');
    return data as Record<string, unknown> | null;
  }
  const res = await fetch(`${supabaseUrl}/functions/v1/attendance-schedule`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
      'x-device-token': token,
    },
    body: JSON.stringify({ device_token: token }),
  });
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
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
  if (!isAttendanceEventFresh(occurred, now, event)) {
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

/** Attach GPS if available within 3s; otherwise send Wi-Fi-only (gps_available=false). */
export async function sendAutoAttendanceEventWithLocation(
  event: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const { requestCurrentPosition } = await import('./geoAttendance');
  const readFix = async (timeout = 3000) => {
    const pos = await Promise.race([
      requestCurrentPosition({
        enableHighAccuracy: true,
        timeout,
        maximumAge: 0,
      }),
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), timeout);
      }),
    ]);
    if (!pos) return null;
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy_m: pos.coords.accuracy ?? null,
    };
  };

  let fix: Record<string, unknown> | null = null;
  try {
    fix = await readFix(3000);
  } catch {
    fix = null;
  }
  const payload = fix
    ? { ...extra, ...fix, gps_available: true }
    : { ...extra, gps_available: false };
  let res = await sendAutoAttendanceEvent(event, payload);
  // Check-out may still ask for GPS.
  if (res?.action === 'need_fresh_location' || res?.action === 'gps_unusable') {
    try {
      fix = await readFix(8000);
      if (fix) {
        res = await sendAutoAttendanceEvent(event, { ...extra, ...fix, gps_available: true });
      }
    } catch {
      /* keep the server reason */
    }
  }
  return res;
}

export function isAutoAttendanceClient(): boolean {
  return isNativeApp() || isDesktopApp() || isIosHomeScreen();
}

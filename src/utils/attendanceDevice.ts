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
  'After this one-time setup, Scorr checks you in only when both are true: this phone is on the office Wi-Fi, and a GPS reading is inside the office radius. Either one alone is not enough. Check-in runs from 1 hour before your shift until the shift ends.';

export const LAPTOP_OPT_IN_TEXT =
  'This laptop checks in only when both are true: it is on the office Wi-Fi, and a GPS reading is inside the office radius. If location is missing or weak, Scorr asks for a fresh location and tries again. Shutting the laptop down does not check you out.';

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

  const now = Date.now();
  const body = {
    device_token: token,
    event,
    occurred_at_utc_ms: now,
    device_now_utc_ms: now,
    device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    device_id: await ensureDeviceId(),
    platform: detectPlatform(),
    ...extra,
  };

  const res = await fetch(`${supabaseUrl}/functions/v1/auto-attendance-event`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
      'x-device-token': token,
    },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Laptop and Test now: attach a fresh GPS fix, and retry once if the server asks. */
export async function sendAutoAttendanceEventWithLocation(
  event: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const { requestCurrentPosition } = await import('./geoAttendance');
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

  let fix: Record<string, unknown> = {};
  try {
    fix = await readFix();
  } catch {
    /* server returns need_fresh_location when the fix is missing */
  }
  let res = await sendAutoAttendanceEvent(event, { ...extra, ...fix });
  if (res?.action === 'need_fresh_location') {
    try {
      fix = await readFix();
      res = await sendAutoAttendanceEvent(event, { ...extra, ...fix });
    } catch {
      /* keep the server reason */
    }
  }
  return res;
}

export function isAutoAttendanceClient(): boolean {
  return isNativeApp() || isDesktopApp() || isIosHomeScreen();
}

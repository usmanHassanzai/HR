/**
 * Automatic attendance device enrollment + schedule helpers (R28–R34).
 * Token never expires; stored in Capacitor Preferences (native Keystore/Keychain
 * backed storage on mobile) / localStorage fallback for Electron preload bridge.
 */
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../lib/supabase';
import { supabaseUrl, supabaseAnonKey } from '../lib/supabaseConfig';
import { isNativeApp, isDesktopApp } from './nativePlatform';

const TOKEN_KEY = 'scorr_attendance_device_token';
const DEVICE_ID_KEY = 'scorr_attendance_device_id';

export const PHONE_OPT_IN_TEXT =
  'After this one-time setup, Scorr checks you in when you arrive at the office or join the office Wi-Fi, and out when you leave. It only checks from 1 hour before your shift until 1 hour after it ends. Outside that time, location and Wi-Fi are never used.';

export const LAPTOP_OPT_IN_TEXT =
  'When this laptop is switched on at the office during your shift window, you are checked in. Shutting it down or putting it to sleep checks you out.';

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
  if (Capacitor.getPlatform() === 'android') return 'android';
  if (Capacitor.getPlatform() === 'ios') return 'ios';
  if (isDesktopApp()) {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) return 'windows';
    return 'linux';
  }
  return 'web';
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
  const platform = detectPlatform();
  if (platform === 'web') {
    return { ok: false, error: 'Automatic attendance needs the Android, iPhone or desktop app.' };
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData.session?.access_token;
  if (!jwt || !supabaseUrl || !supabaseAnonKey) {
    return { ok: false, error: 'Sign in once to enable automatic attendance.' };
  }

  const deviceId = await ensureDeviceId();
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const res = await fetch(`${supabaseUrl}/functions/v1/register-attendance-device`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      device_id: deviceId,
      platform,
      device_timezone: deviceTimezone,
      app_version: appVersion || null,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.device_token) {
    return { ok: false, error: json?.error || 'Registration failed' };
  }

  await secureSet(TOKEN_KEY, json.device_token);

  // Electron: also persist via safeStorage if preload exposes it
  try {
    (window as unknown as { scorrDesktop?: { saveAttendanceToken?: (t: string) => void } })
      .scorrDesktop?.saveAttendanceToken?.(json.device_token);
  } catch {
    /* ignore */
  }

  return { ok: true, device_token: json.device_token };
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

export function isAutoAttendanceClient(): boolean {
  return isNativeApp() || isDesktopApp();
}

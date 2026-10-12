import { registerPlugin } from '@capacitor/core';
import { supabaseUrl, supabaseAnonKey } from '../lib/supabaseConfig';
import { packageVersion } from './appUpdate';
import { isAndroidApp } from './nativePlatform';
import { getAttendanceDeviceToken } from './attendanceDevice';

interface AttendancePingPlugin {
  startAutoAttendance(options: {
    supabaseUrl: string;
    anonKey: string;
    deviceToken: string;
    deviceId: string;
    appVersion?: string;
  }): Promise<void>;
  stopAutoAttendance(): Promise<void>;
  syncSchedule(): Promise<{ ok?: boolean }>;
  isAutoAttendanceEnabled?(): Promise<{
    enabled?: boolean;
    hasToken?: boolean;
    insideWindow?: boolean;
  }>;
  /** @deprecated JWT path removed */
  stop(): Promise<void>;
}

const AttendancePing = registerPlugin<AttendancePingPlugin>('AttendancePing');

const DEVICE_ID_KEY = 'scorr_attendance_device_id';

async function resolveDeviceId(): Promise<string> {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
    if (value) return value;
  } catch {
    /* fall through */
  }
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const id = crypto.randomUUID();
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: DEVICE_ID_KEY, value: id });
  } catch {
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

/**
 * Android only: Wi-Fi auto check-in via device token + schedule window.
 * iOS auto path stays off.
 * Throws when the plugin rejects so enroll UI can surface a real warning.
 */
export async function startNativeAttendancePings(): Promise<void> {
  if (!isAndroidApp()) return;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase config — cannot start background check-in.');
  }
  const deviceToken = await getAttendanceDeviceToken();
  if (!deviceToken) {
    throw new Error('No device token saved — register this device first.');
  }
  const deviceId = await resolveDeviceId();
  await AttendancePing.startAutoAttendance({
    supabaseUrl,
    anonKey: supabaseAnonKey,
    deviceToken,
    deviceId,
    appVersion: packageVersion(),
  });
}

/** True when native EncryptedSharedPreferences has token + enabled (FGS can arm). */
export async function isNativeAutoAttendanceArmed(): Promise<boolean> {
  if (!isAndroidApp()) return false;
  try {
    if (typeof AttendancePing.isAutoAttendanceEnabled !== 'function') return false;
    const res = await AttendancePing.isAutoAttendanceEnabled();
    return Boolean(res?.enabled);
  } catch {
    return false;
  }
}

export async function refreshNativeAttendanceSession(): Promise<void> {
  if (!isAndroidApp()) return;
  const deviceToken = await getAttendanceDeviceToken();
  if (!deviceToken) return;
  try {
    await AttendancePing.syncSchedule();
  } catch {
    /* ignore */
  }
}

export async function stopNativeAttendancePings(): Promise<void> {
  if (!isAndroidApp()) return;
  try {
    await AttendancePing.stopAutoAttendance();
  } catch {
    try {
      await AttendancePing.stop();
    } catch {
      /* ignore */
    }
  }
}

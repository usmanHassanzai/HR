import { registerPlugin } from '@capacitor/core';
import { supabaseUrl, supabaseAnonKey } from '../lib/supabaseConfig';
import { isNativeApp } from './nativePlatform';
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
 * Native Android/iOS: schedule-window geofence (+ Wi-Fi supporting signal) auto
 * attendance via non-expiring device token. No JWT forever-ping.
 */
export async function startNativeAttendancePings(): Promise<void> {
  if (!isNativeApp() || !supabaseUrl || !supabaseAnonKey) return;
  const deviceToken = await getAttendanceDeviceToken();
  if (!deviceToken) return;
  try {
    const deviceId = await resolveDeviceId();
    await AttendancePing.startAutoAttendance({
      supabaseUrl,
      anonKey: supabaseAnonKey,
      deviceToken,
      deviceId,
      appVersion: '1.3.12',
    });
  } catch {
    /* web / plugin unavailable */
  }
}

/** Re-fetch schedule and re-arm window alarms (device-token path). */
export async function refreshNativeAttendanceSession(): Promise<void> {
  if (!isNativeApp()) return;
  const deviceToken = await getAttendanceDeviceToken();
  if (!deviceToken) return;
  try {
    await AttendancePing.syncSchedule();
  } catch {
    /* ignore */
  }
}

export async function stopNativeAttendancePings(): Promise<void> {
  if (!isNativeApp()) return;
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

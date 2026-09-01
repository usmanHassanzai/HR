import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './nativePlatform';

interface AttendancePingPlugin {
  start(options: { supabaseUrl: string; anonKey: string; accessToken: string }): Promise<void>;
  stop(): Promise<void>;
  updateSession(options: { accessToken: string }): Promise<void>;
}

const AttendancePing = registerPlugin<AttendancePingPlugin>('AttendancePing');

/** Native background GPS polling is disabled. start() is a no-op. */
export async function startNativeAttendancePings(): Promise<void> {
  await stopNativeAttendancePings();
}

export async function refreshNativeAttendanceSession(): Promise<void> {
  /* no background session to refresh */
}

export async function stopNativeAttendancePings(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await AttendancePing.stop();
  } catch {
    /* ignore */
  }
}

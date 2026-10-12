import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './nativePlatform';

interface AttendancePingPlugin {
  stopAutoAttendance(): Promise<void>;
  /** @deprecated JWT path removed */
  stop(): Promise<void>;
}

const AttendancePing = registerPlugin<AttendancePingPlugin>('AttendancePing');

/**
 * Native Android/iOS auto attendance — paused while rules are rebuilt.
 */
export async function startNativeAttendancePings(): Promise<void> {
  return;
}

export async function refreshNativeAttendanceSession(): Promise<void> {
  return;
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

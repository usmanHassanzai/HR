import { AttendancePing } from './attendancePingPlugin';

const KEY = 'scorr-attendance-notifications';

/** Screen alerts for check-in and check-out. Off until the person turns them on. */
export function attendanceNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

async function pushAttendanceNotificationPref(enabled: boolean): Promise<void> {
  try {
    const desk = window.scorrDesktop?.setAttendanceNotifications;
    if (desk) await Promise.resolve(desk(enabled));
  } catch {
    /* desktop bridge is optional */
  }
  try {
    if (typeof AttendancePing.setAttendanceNotifications === 'function') {
      await AttendancePing.setAttendanceNotifications({ enabled });
    }
  } catch {
    /* phone bridge is optional on the website */
  }
}

export async function setAttendanceNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
  await pushAttendanceNotificationPref(enabled);
}

/** Tell Windows, Linux, and the phone the current choice. Missing choice stays off. */
export async function syncAttendanceNotificationPref(): Promise<void> {
  await pushAttendanceNotificationPref(attendanceNotificationsEnabled());
}

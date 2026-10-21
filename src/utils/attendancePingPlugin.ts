/**
 * Single Capacitor registration for AttendancePing.
 * Import this module everywhere — never call registerPlugin('AttendancePing') again
 * (duplicate registration breaks Android / Electron webviews).
 */
import { registerPlugin } from '@capacitor/core';

export type AttendancePingPlugin = {
  // Auto attendance
  startAutoAttendance?(options: {
    supabaseUrl: string;
    anonKey: string;
    deviceToken: string;
    deviceId: string;
    appVersion?: string;
  }): Promise<void>;
  stopAutoAttendance?(): Promise<void>;
  syncSchedule?(): Promise<{ ok?: boolean }>;
  isAutoAttendanceEnabled?(): Promise<{
    enabled?: boolean;
    hasToken?: boolean;
    insideWindow?: boolean;
  }>;
  /** @deprecated JWT path removed */
  stop?(): Promise<void>;

  // Permissions / settings
  openAppSettings?(): Promise<void>;
  openBatterySettings?(): Promise<void>;
  openNotificationSettings?(): Promise<{ opened?: boolean }>;
  getPermissionSnapshot?(): Promise<{
    location?: string;
    coarseLocation?: string;
    backgroundLocation?: string;
    precise?: boolean;
    locationServicesEnabled?: boolean;
    notifications?: string;
    batteryUnrestricted?: boolean | null;
    nearbyWifi?: string;
    exactAlarm?: string;
    manufacturer?: string;
  }>;
  requestNotifications?(): Promise<{ status?: string }>;
  requestAlwaysLocation?(): Promise<{
    status?: string;
    location?: string;
    backgroundLocation?: string;
  }>;
  requestNearbyWifi?(): Promise<{ status?: string }>;
  requestBatteryUnrestricted?(): Promise<{ opened?: boolean; batteryUnrestricted?: boolean }>;
  requestExactAlarms?(): Promise<{ exactAlarm?: string }>;
  setAutoLaunch?(enabled: boolean): Promise<{ ok?: boolean }>;
  getAutoLaunch?(): Promise<{ enabled?: boolean }>;
  probeNetwork?(): Promise<{ ssid?: string; bssid?: string }>;

  // Trusted device
  saveTrustedDeviceToken?(options: { token: string }): Promise<void>;
  loadTrustedDeviceToken?(): Promise<{ token?: string | null }>;
  clearTrustedDeviceToken?(): Promise<void>;

  // Remembered login
  saveLoginCredentials?(options: { email: string; password: string }): Promise<void>;
  loadLoginCredentials?(): Promise<{ email?: string | null; password?: string | null }>;
  clearLoginCredentials?(): Promise<void>;
};

/** The one-and-only AttendancePing Capacitor bridge. */
export const AttendancePing = registerPlugin<AttendancePingPlugin>('AttendancePing');

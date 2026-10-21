/**
 * Automatic attendance setup — shared eligibility, registration, progress.
 */
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../lib/supabase';
import {
  clientAttendancePlatform,
  isDesktopApp,
  isIosHomeScreen,
  isNativeApp,
} from './nativePlatform';
import { AttendancePing } from './attendancePingPlugin';
import { withTimeout } from './withTimeout';
import { getAttendanceDeviceToken } from './attendanceDevice';

const PROGRESS_KEY = 'scorr_auto_attend_setup_step';

export type SetupStatus = {
  ok: boolean;
  issues: string[];
  user: {
    id: string;
    full_name: string | null;
    email: string;
    role: string;
    work_mode: string;
    auto_phone_attendance: boolean;
    auto_laptop_attendance: boolean;
  };
  company: {
    id: string;
    name: string;
    timezone: string | null;
    auto_phone_attendance: boolean;
    auto_laptop_attendance: boolean;
  };
  office: { id: string; name: string } | null;
  shift: { id: string; name: string } | null;
  has_enrolled_device: boolean;
  enrolled_device_count: number;
  is_admin: boolean;
};

export function loadSetupProgress(): number {
  try {
    const n = Number(localStorage.getItem(PROGRESS_KEY) || '0');
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveSetupProgress(step: number): void {
  try {
    localStorage.setItem(PROGRESS_KEY, String(step));
  } catch {
    /* ignore */
  }
}

export function clearSetupProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    /* ignore */
  }
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  return withTimeout(
    (async () => {
      const { data, error } = await supabase.rpc('get_auto_attendance_setup_status');
      if (error) throw new Error(error.message);
      const raw = (data || {}) as Partial<SetupStatus> & { message?: string; ready?: boolean };
      const issuesRaw = raw.issues;
      const issues = Array.isArray(issuesRaw)
        ? issuesRaw.map(String)
        : typeof raw.message === 'string' && raw.ready === false
          ? [raw.message]
          : [];
      return {
        ok: Boolean(raw.ok ?? raw.ready ?? issues.length === 0),
        issues,
        user: raw.user as SetupStatus['user'],
        company: raw.company as SetupStatus['company'],
        office: raw.office ?? null,
        shift: raw.shift ?? null,
        has_enrolled_device: Boolean(raw.has_enrolled_device),
        enrolled_device_count: Number(raw.enrolled_device_count || 0),
        is_admin: Boolean(raw.is_admin),
      };
    })(),
    15_000,
    'Checking your account',
  );
}

export async function registerDeviceViaRpc(appVersion?: string): Promise<{
  ok: boolean;
  device_token?: string;
  error?: string;
}> {
  const platform = clientAttendancePlatform();
  const version =
    appVersion ||
    (() => {
      try {
        return String(import.meta.env.VITE_APP_VERSION || '1.3.24');
      } catch {
        return '1.3.24';
      }
    })();

  if (platform === 'web') {
    return {
      ok: false,
      error:
        'Automatic Wi-Fi check-in needs the Android, iOS, or desktop app. The browser cannot stay enrolled in the background.',
    };
  }

  // Home Screen / Safari “ios” without Capacitor — no background geofence plugin.
  if (platform === 'ios' && !Capacitor.isNativePlatform()) {
    return {
      ok: false,
      error:
        'Automatic check-in needs the installable Scorr iOS app (not Add to Home Screen).',
    };
  }

  try {
    const { Preferences } = await import('@capacitor/preferences');
    let deviceId: string | null = null;
    if (Capacitor.isNativePlatform()) {
      deviceId = (await Preferences.get({ key: 'scorr_attendance_device_id' })).value;
    }
    if (!deviceId) {
      try {
        deviceId = localStorage.getItem('scorr_attendance_device_id');
      } catch {
        deviceId = null;
      }
    }
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      if (Capacitor.isNativePlatform()) {
        await withTimeout(
          Preferences.set({ key: 'scorr_attendance_device_id', value: deviceId }),
          8_000,
          'Saving device id',
        );
      } else {
        localStorage.setItem('scorr_attendance_device_id', deviceId);
      }
    }

    const { data, error } = await withTimeout(
      Promise.resolve(
        supabase.rpc('register_attendance_device', {
          p_device_id: deviceId,
          p_platform: platform,
          p_device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          p_app_version: version,
          p_token_plaintext: null,
        }),
      ),
      15_000,
      'Registering this device',
    );

    if (error) {
      const { friendlyAutoAttendanceError } = await import('./attendanceDevice');
      return { ok: false, error: friendlyAutoAttendanceError(error.message) };
    }
    const row = data as { ok?: boolean; device_token?: string; message?: string; status?: string } | null;
    if (row && row.ok === false) {
      const { friendlyAutoAttendanceError } = await import('./attendanceDevice');
      return {
        ok: false,
        error: friendlyAutoAttendanceError(
          row.message || row.status || 'Registration failed.',
          'Couldn’t enable automatic check-in. Try again.',
        ),
      };
    }
    const token = row?.device_token;
    if (!token) {
      return { ok: false, error: 'Couldn’t enable automatic check-in. Try again.' };
    }

    if (Capacitor.isNativePlatform()) {
      await withTimeout(
        Preferences.set({ key: 'scorr_attendance_device_token', value: token }),
        8_000,
        'Saving device token',
      );
    } else {
      localStorage.setItem('scorr_attendance_device_token', token);
    }

    try {
      const save = (
        window as unknown as {
          scorrDesktop?: { saveAttendanceToken?: (t: string) => Promise<boolean> | boolean | void };
        }
      ).scorrDesktop?.saveAttendanceToken;
      if (save) await Promise.resolve(save(token));
    } catch {
      /* ignore */
    }

    return { ok: true, device_token: token };
  } catch (e) {
    const { friendlyAutoAttendanceError } = await import('./attendanceDevice');
    return {
      ok: false,
      error: friendlyAutoAttendanceError(e, 'Couldn’t enable automatic check-in. Try again.'),
    };
  }
}

/** Escalate to Always / “All the time” after When-In-Use (iOS + Android). */
export async function requestAlwaysLocation(): Promise<{ ok: boolean; detail: string; status?: string }> {
  if (!isNativeApp()) return { ok: true, detail: 'Not required' };

  const fromSnapshot = async (): Promise<{ ok: boolean; detail: string; status?: string }> => {
    const snap = await getNativePermissionSnapshot();
    const fg = snap.location === 'granted' || snap.coarseLocation === 'granted';
    const bg = snap.backgroundLocation === 'granted';
    if (bg) return { ok: true, detail: 'Always location allowed', status: 'granted' };
    if (fg) {
      return {
        ok: false,
        detail: 'Open Settings → Scorr → Location → Allow all the time, then return here.',
        status: 'when_in_use',
      };
    }
    return {
      ok: false,
      detail: 'Location was not allowed. Open Settings → Scorr → Location → Allow all the time.',
      status: 'denied',
    };
  };

  try {
    const res = await withTimeout(
      AttendancePing.requestAlwaysLocation!(),
      20_000,
      'Waiting for Always location',
    );
    if (res.status === 'granted' || res.backgroundLocation === 'granted') {
      return { ok: true, detail: 'Always location allowed', status: 'granted' };
    }
    if (res.status === 'when_in_use' || res.location === 'granted') {
      return {
        ok: false,
        detail: 'Open Settings → Scorr → Location → Allow all the time, then return here.',
        status: 'when_in_use',
      };
    }
    return {
      ok: false,
      detail: 'Location was not allowed. Open Settings → Scorr → Location → Allow all the time.',
      status: res.status || 'denied',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Older APKs without the method — fall back to snapshot instead of error spam.
    if (/not implemented/i.test(msg)) {
      try {
        return await fromSnapshot();
      } catch {
        return {
          ok: false,
          detail: 'Open Settings → Scorr → Location → Allow all the time, then return here.',
          status: 'when_in_use',
        };
      }
    }
    return { ok: false, detail: msg };
  }
}

function requestBrowserLocation(): Promise<{ ok: boolean; detail: string }> {
  if (!navigator.geolocation) {
    return Promise.resolve({
      ok: false,
      detail: 'This iPhone cannot share location with the Home Screen app.',
    });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve({ ok: true, detail: 'Location allowed' }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          resolve({
            ok: false,
            detail:
              'Location was blocked. Open iPhone Settings → Privacy & Security → Location Services → Scorr (or Safari Websites) → While Using the App, then return here.',
          });
          return;
        }
        resolve({
          ok: false,
          detail: 'Could not read location. Turn on Location Services and try again.',
        });
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

export async function requestWhileUsingLocation(): Promise<{ ok: boolean; detail: string }> {
  if (isIosHomeScreen()) return requestBrowserLocation();
  if (!isNativeApp()) return { ok: true, detail: 'Not required on this platform' };
  try {
    const perm = await withTimeout(Geolocation.checkPermissions(), 10_000, 'Checking location permission');
    if (perm.location === 'granted' || perm.coarseLocation === 'granted') {
      return { ok: true, detail: 'Location allowed while using the app' };
    }
    const req = await withTimeout(
      Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] }),
      15_000,
      'Waiting for location permission',
    );
    if (req.location === 'granted' || req.coarseLocation === 'granted') {
      return { ok: true, detail: 'Location allowed while using the app' };
    }
    return { ok: false, detail: 'Location was not allowed. Tap Open settings and choose While using the app.' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function getNativePermissionSnapshot() {
  if (isIosHomeScreen()) {
    let location: PermissionState | 'prompt' = 'prompt';
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      location = status.state;
    } catch {
      location = 'prompt';
    }
    const notif =
      typeof Notification === 'undefined'
        ? 'granted'
        : Notification.permission === 'granted'
          ? 'granted'
          : Notification.permission === 'denied'
            ? 'denied'
            : 'prompt';
    return {
      location: location === 'granted' ? 'granted' : location === 'denied' ? 'denied' : 'prompt',
      coarseLocation: location === 'granted' ? 'granted' : 'prompt',
      backgroundLocation: location === 'granted' ? 'granted' : 'prompt',
      precise: true,
      locationServicesEnabled: true,
      notifications: notif,
      batteryUnrestricted: true,
      manufacturer: 'Apple',
    };
  }
  if (!isNativeApp()) {
    return {
      location: 'granted',
      backgroundLocation: 'granted',
      precise: true,
      locationServicesEnabled: true,
      notifications: 'granted',
      batteryUnrestricted: true,
      manufacturer: '',
    };
  }
  try {
    return await withTimeout(AttendancePing.getPermissionSnapshot!(), 12_000, 'Reading device permissions');
  } catch {
    // Fallback to Capacitor geolocation only
    try {
      const perm = await Geolocation.checkPermissions();
      return {
        location: perm.location,
        coarseLocation: perm.coarseLocation,
        backgroundLocation: 'prompt',
        precise: true,
        locationServicesEnabled: true,
        notifications: 'prompt',
        batteryUnrestricted: null,
        manufacturer: '',
      };
    } catch (e) {
      throw e;
    }
  }
}

export async function openNativeAppSettings(): Promise<void> {
  if (!isNativeApp()) return;
  await withTimeout(AttendancePing.openAppSettings!(), 10_000, 'Opening settings');
}

export async function openNativeBatterySettings(): Promise<void> {
  if (!isNativeApp()) return;
  await withTimeout(AttendancePing.openBatterySettings!(), 10_000, 'Opening battery settings');
}

/** Request iOS Capacitor access for geofence auto attendance (When-In-Use → Always + notifications). */
export async function requestAllIosAutoAttendanceAccess(): Promise<{
  ok: boolean;
  warnings: string[];
  error?: string;
}> {
  const warnings: string[] = [];
  const whileUsing = await requestWhileUsingLocation();
  if (!whileUsing.ok) {
    return { ok: false, warnings, error: whileUsing.detail };
  }
  const notif = await requestNativeNotifications();
  if (!notif.ok) warnings.push(notif.detail);
  const always = await requestAlwaysLocation();
  if (!always.ok) {
    return {
      ok: false,
      warnings,
      error:
        always.detail ||
        'Allow Location → Always so automatic check-in works when Scorr is closed.',
    };
  }
  try {
    const snap = await getNativePermissionSnapshot();
    if (snap.notifications !== 'granted' && snap.notifications !== 'authorized') {
      warnings.push('Allow notifications for check-in alerts.');
    }
  } catch {
    /* optional */
  }
  return { ok: true, warnings };
}

/** Request every Android access auto attendance needs (location, Wi‑Fi, alerts, battery, alarms). */
export async function requestAllAndroidAutoAttendanceAccess(): Promise<{
  ok: boolean;
  warnings: string[];
  error?: string;
}> {
  const warnings: string[] = [];
  const whileUsing = await requestWhileUsingLocation();
  if (!whileUsing.ok) {
    return { ok: false, warnings, error: whileUsing.detail };
  }
  const notif = await requestNativeNotifications();
  if (!notif.ok) warnings.push(notif.detail);
  try {
    if (typeof AttendancePing.requestNearbyWifi === 'function') {
      const wifi = await withTimeout(
        AttendancePing.requestNearbyWifi(),
        15_000,
        'Waiting for Wi-Fi permission',
      );
      if (wifi.status !== 'granted') {
        warnings.push('Allow Nearby Wi‑Fi / Wi‑Fi devices so office SSID can be read.');
      }
    }
  } catch {
    /* older APK */
  }
  const always = await requestAlwaysLocation();
  if (!always.ok) {
    return {
      ok: false,
      warnings,
      error:
        always.detail ||
        'Allow location All the time so automatic check-in works when Scorr is closed.',
    };
  }
  try {
    if (typeof AttendancePing.requestBatteryUnrestricted === 'function') {
      await withTimeout(
        AttendancePing.requestBatteryUnrestricted(),
        12_000,
        'Opening battery prompt',
      );
    } else {
      await openNativeBatterySettings();
    }
  } catch {
    warnings.push('Set battery use to Unrestricted for Scorr.');
  }
  try {
    if (typeof AttendancePing.requestExactAlarms === 'function') {
      await withTimeout(AttendancePing.requestExactAlarms(), 12_000, 'Opening alarm settings');
    }
  } catch {
    /* optional */
  }
  try {
    const snap = await getNativePermissionSnapshot();
    if (snap.batteryUnrestricted === false) {
      warnings.push('Confirm Unrestricted battery for Scorr so background check-in is not paused.');
    }
    if (snap.notifications !== 'granted' && snap.notifications !== 'authorized') {
      warnings.push('Allow notifications so the attendance service can stay active.');
    }
    if (snap.nearbyWifi === 'denied') {
      warnings.push('Allow Nearby Wi‑Fi devices for office SSID matching.');
    }
    if (snap.exactAlarm === 'denied') {
      warnings.push('Allow Alarms & reminders so Scorr wakes at shift start.');
    }
  } catch {
    /* snapshot optional */
  }
  return { ok: true, warnings };
}

/** Desktop: notifications + location prompt + auto-launch + Wi‑Fi probe. */
export async function requestAllDesktopAutoAttendanceAccess(): Promise<{
  ok: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const skipNotificationPermission = window.scorrDesktop?.platform === 'win32';
  try {
    if (
      !skipNotificationPermission &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    ) {
      await Notification.requestPermission();
    }
  } catch {
    /* ignore */
  }
  try {
    await new Promise<void>((resolve) => {
      if (!navigator.geolocation) {
        resolve();
        return;
      }
      navigator.geolocation.getCurrentPosition(
        () => resolve(),
        () => resolve(),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });
  } catch {
    /* ignore */
  }
  try {
    const set = window.scorrDesktop?.setAutoLaunch;
    if (set) await Promise.resolve(set(true));
  } catch {
    warnings.push('Turn on “Open at login” in the desktop app if auto-start is off.');
  }
  return { ok: true, warnings };
}

export async function requestNativeNotifications(): Promise<{ ok: boolean; detail: string }> {
  if (isIosHomeScreen()) {
    if (typeof Notification === 'undefined' || !('requestPermission' in Notification)) {
      return { ok: true, detail: 'Notifications are not available on this iPhone. Check-in still works.' };
    }
    try {
      const status = await Notification.requestPermission();
      if (status === 'granted') return { ok: true, detail: 'Notifications allowed' };
      return { ok: true, detail: 'Notifications were not allowed. Check-in still works.' };
    } catch (e) {
      return { ok: true, detail: e instanceof Error ? e.message : 'Check-in still works without notifications.' };
    }
  }
  if (!isNativeApp()) return { ok: true, detail: 'Not required' };
  try {
    // Prefer live snapshot so we don't treat a stale "prompt" as denial.
    try {
      const before = await getNativePermissionSnapshot();
      if (before.notifications === 'granted' || before.notifications === 'authorized') {
        return { ok: true, detail: 'Notifications allowed' };
      }
    } catch {
      /* continue to request */
    }
    const res = await withTimeout(AttendancePing.requestNotifications!(), 15_000, 'Waiting for notification permission');
    if (res.status === 'granted' || res.status === 'authorized') {
      return { ok: true, detail: 'Notifications allowed' };
    }
    // Re-check: Android may return promptly while the system toggle is already on.
    try {
      const after = await getNativePermissionSnapshot();
      if (after.notifications === 'granted' || after.notifications === 'authorized') {
        return { ok: true, detail: 'Notifications allowed' };
      }
    } catch {
      /* ignore */
    }
    return { ok: false, detail: 'Notifications were not allowed. You can enable them in Settings.' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export function batteryTips(manufacturer: string): string[] {
  const m = (manufacturer || '').toLowerCase();
  if (m.includes('xiaomi') || m.includes('redmi') || m.includes('poco')) {
    return [
      'Settings → Apps → Scorr → Battery saver → No restrictions',
      'Also enable Autostart for Scorr',
    ];
  }
  if (m.includes('oppo') || m.includes('realme') || m.includes('oneplus')) {
    return ['Settings → Apps → Scorr → Battery → Allow background activity / Unrestricted'];
  }
  if (m.includes('vivo') || m.includes('iqoo')) {
    return ['Settings → Battery → Background power consumption → Scorr → High'];
  }
  if (m.includes('samsung')) {
    return ['Settings → Apps → Scorr → Battery → Unrestricted', 'Disable "Put unused apps to sleep" for Scorr'];
  }
  return ['Settings → Apps → Scorr → Battery → Unrestricted'];
}

export async function probeOfficeNetworkMatch(): Promise<{
  matched: boolean;
  label: string | null;
  ip: string;
  ssid: string;
  bssid: string;
  message: string;
}> {
  let ip = 'unknown';
  try {
    const r = await withTimeout(fetch('https://api.ipify.org?format=json'), 10_000, 'Checking public IP');
    const j = (await r.json()) as { ip?: string };
    if (j.ip) ip = j.ip;
  } catch {
    ip = 'unavailable';
  }
  let ssid = '';
  let bssid = '';
  try {
    if (typeof AttendancePing.probeNetwork === 'function') {
      const n = await withTimeout(AttendancePing.probeNetwork(), 8_000, 'Reading Wi-Fi');
      ssid = n?.ssid || '';
      bssid = n?.bssid || '';
    }
  } catch {
    /* web */
  }

  const { data: offices } = await supabase.rpc('get_office_locations');
  const list = (offices || []) as Array<{ id: string; active?: boolean }>;
  const active = list.find((o) => o.active) || list[0];
  if (!active?.id || ip === 'unavailable' || ip === 'unknown') {
    return {
      matched: false,
      label: null,
      ip,
      ssid,
      bssid,
      message: 'No network matched',
    };
  }
  const { data } = await supabase.rpc('test_office_wifi_match', {
    p_office_id: active.id,
    p_client_ip: ip,
    p_ssid: ssid || null,
    p_bssid: bssid || null,
  });
  const row = data as { matched?: boolean; network_label?: string; message?: string };
  return {
    matched: Boolean(row?.matched),
    label: row?.network_label || null,
    ip,
    ssid,
    bssid,
    message: row?.message || (row?.matched ? 'Matched' : 'No network matched'),
  };
}

export async function isDeviceAlreadyEnrolled(): Promise<boolean> {
  return Boolean(await getAttendanceDeviceToken());
}

export { isNativeApp, isDesktopApp };

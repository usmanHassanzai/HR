/**
 * Settings → save / remove this device for background auto attendance
 * (Android FGS + desktop Electron heartbeat). iOS / browser: not offered.
 */
import { packageVersion } from './appUpdate';
import {
  disableAutoAttendanceOnDevice,
  getAttendanceDeviceToken,
  PHONE_OPT_IN_TEXT,
  LAPTOP_OPT_IN_TEXT,
  registerAttendanceDevice,
} from './attendanceDevice';
import {
  startNativeAttendancePings,
  stopNativeAttendancePings,
} from './attendanceNativePing';
import {
  batteryTips,
  clearSetupProgress,
  fetchSetupStatus,
  getNativePermissionSnapshot,
  openNativeAppSettings,
  openNativeBatterySettings,
  requestAlwaysLocation,
  requestNativeNotifications,
  requestWhileUsingLocation,
} from './autoAttendanceSetup';
import {
  clientAttendancePlatform,
  isAndroidApp,
  isDesktopApp,
  isIosApp,
  isIosHomeScreen,
} from './nativePlatform';

export type AutoAttendanceClientKind = 'android' | 'desktop' | 'unsupported';

export type AutoAttendanceSaveStatus = {
  kind: AutoAttendanceClientKind;
  platformLabel: string;
  saved: boolean;
  optInText: string;
  setupIssues: string[];
  permissionLines: string[];
  batteryLines: string[];
  needsLocation: boolean;
  needsBackgroundLocation: boolean;
  needsNotifications: boolean;
  needsBattery: boolean;
};

function clientKind(): AutoAttendanceClientKind {
  if (isAndroidApp()) return 'android';
  if (isDesktopApp()) return 'desktop';
  return 'unsupported';
}

function platformLabel(): string {
  const p = clientAttendancePlatform();
  if (p === 'android') return 'Android';
  if (p === 'windows') return 'Windows desktop';
  if (p === 'linux') return 'Linux desktop';
  if (p === 'ios' || isIosApp() || isIosHomeScreen()) return 'iOS';
  return 'Browser';
}

export function isAutoAttendanceSaveSupported(): boolean {
  return clientKind() !== 'unsupported';
}

export async function getAutoAttendanceSaveStatus(): Promise<AutoAttendanceSaveStatus> {
  const kind = clientKind();
  const saved = Boolean(await getAttendanceDeviceToken());
  const optInText = kind === 'desktop' ? LAPTOP_OPT_IN_TEXT : PHONE_OPT_IN_TEXT;

  let setupIssues: string[] = [];
  try {
    const st = await fetchSetupStatus();
    setupIssues = Array.isArray(st.issues) ? st.issues.map(String) : [];
  } catch {
    /* status RPC optional for UI */
  }

  const permissionLines: string[] = [];
  let needsLocation = false;
  let needsBackgroundLocation = false;
  let needsNotifications = false;
  let needsBattery = false;
  let batteryLines: string[] = [];

  if (kind === 'android') {
    try {
      const snap = await getNativePermissionSnapshot();
      const locGranted = snap.location === 'granted' || snap.coarseLocation === 'granted';
      needsLocation = !locGranted;
      needsBackgroundLocation = snap.backgroundLocation !== 'granted';
      needsNotifications = snap.notifications !== 'granted' && snap.notifications !== 'authorized';
      if (snap.batteryUnrestricted === false) {
        needsBattery = true;
        batteryLines = batteryTips(String(snap.manufacturer || ''));
      }
      if (needsLocation) {
        permissionLines.push('Location (While using the app) is required for office-radius check-in.');
      }
      if (needsBackgroundLocation) {
        permissionLines.push('Allow location “All the time” so check-in works when Scorr is closed.');
      }
      if (needsNotifications) {
        permissionLines.push('Notifications let Android keep the attendance service visible.');
      }
      if (needsBattery) {
        permissionLines.push('Set battery to Unrestricted so background check-in is not killed.');
      }
      if (!permissionLines.length && saved) {
        permissionLines.push('Permissions look ready on this phone.');
      }
    } catch {
      permissionLines.push('Could not read permission status. Tap Save to request them.');
    }
  } else if (kind === 'desktop') {
    permissionLines.push(
      'Desktop uses Wi‑Fi probing and optional location while the app (or tray) is running after save.',
    );
  } else {
    permissionLines.push('Use the Android app or desktop app to save this account for background check-in.');
  }

  return {
    kind,
    platformLabel: platformLabel(),
    saved,
    optInText,
    setupIssues,
    permissionLines,
    batteryLines,
    needsLocation,
    needsBackgroundLocation,
    needsNotifications,
    needsBattery,
  };
}

async function clearDesktopAttendanceToken(): Promise<void> {
  try {
    const clear = window.scorrDesktop?.clearAttendanceToken;
    if (clear) await Promise.resolve(clear());
  } catch {
    /* ignore */
  }
}

async function enableDesktopAutoLaunch(): Promise<void> {
  try {
    const set = window.scorrDesktop?.setAutoLaunch;
    if (set) await Promise.resolve(set(true));
  } catch {
    /* ignore */
  }
}

/**
 * One-tap enroll: permissions → register device → persist token → arm background.
 */
export async function saveAccountForAutoAttendance(): Promise<{
  ok: boolean;
  error?: string;
  warnings: string[];
}> {
  const kind = clientKind();
  const warnings: string[] = [];

  if (kind === 'unsupported') {
    return {
      ok: false,
      error:
        'Background check-in needs the Android app or desktop app. The browser and iOS cannot stay enrolled.',
      warnings,
    };
  }

  if (kind === 'android') {
    const whileUsing = await requestWhileUsingLocation();
    if (!whileUsing.ok) {
      return { ok: false, error: whileUsing.detail, warnings };
    }
    const always = await requestAlwaysLocation();
    if (!always.ok) {
      warnings.push(always.detail);
    }
    const notif = await requestNativeNotifications();
    if (!notif.ok) {
      warnings.push(notif.detail);
    }
  }

  const reg = await registerAttendanceDevice(packageVersion());
  if (!reg.ok || !reg.device_token) {
    return { ok: false, error: reg.error || 'Could not register this device.', warnings };
  }

  clearSetupProgress();

  if (kind === 'android') {
    try {
      await startNativeAttendancePings();
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : 'Background service did not start yet.');
    }
  }

  if (kind === 'desktop') {
    await enableDesktopAutoLaunch();
    // registerDeviceViaRpc already calls saveAttendanceToken → main process heartbeat
  }

  return { ok: true, warnings };
}

export async function removeAccountFromAutoAttendance(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const kind = clientKind();
  const disableKind = kind === 'desktop' ? 'laptop' : 'phone';

  try {
    await disableAutoAttendanceOnDevice(disableKind);
  } catch (e) {
    // Still clear local store / stop FGS even if RPC fails
    try {
      const { Preferences } = await import('@capacitor/preferences');
      if (isAndroidApp()) {
        await Preferences.remove({ key: 'scorr_attendance_device_token' });
      }
    } catch {
      /* ignore */
    }
    try {
      localStorage.removeItem('scorr_attendance_device_token');
    } catch {
      /* ignore */
    }
    await stopNativeAttendancePings();
    await clearDesktopAttendanceToken();
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Could not revoke on server; local save was cleared.',
    };
  }

  await clearDesktopAttendanceToken();
  clearSetupProgress();
  return { ok: true };
}

export { openNativeAppSettings, openNativeBatterySettings };

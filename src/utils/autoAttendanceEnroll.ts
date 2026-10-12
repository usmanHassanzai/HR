/**
 * Settings → save / remove this device for background auto attendance
 * (Android FGS + desktop Electron heartbeat). iOS / browser: not offered.
 */
import { packageVersion } from './appUpdate';
import {
  disableAutoAttendanceOnDevice,
  friendlyAutoAttendanceError,
  getAttendanceDeviceToken,
  PHONE_OPT_IN_TEXT,
  LAPTOP_OPT_IN_TEXT,
  registerAttendanceDevice,
} from './attendanceDevice';
import {
  isNativeAutoAttendanceArmed,
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
  /** WebView Preferences token present (server device registered). */
  saved: boolean;
  /** Android: native store enabled so FGS/schedule can run. Desktop: same as saved. */
  backgroundArmed: boolean;
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
  const backgroundArmed =
    kind === 'android' ? (saved ? await isNativeAutoAttendanceArmed() : false) : saved;
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
        permissionLines.push('Allow location while using the app for office-area check-in.');
      }
      if (needsBackgroundLocation) {
        permissionLines.push('Allow location “All the time” so check-in works when Scorr is closed.');
      }
      if (needsNotifications) {
        permissionLines.push('Allow notifications so automatic check-in can keep running.');
      }
      if (needsBattery) {
        permissionLines.push('Set battery use to Unrestricted so automatic check-in is not paused.');
      }
      if (saved && !backgroundArmed) {
        permissionLines.push(
          'Background check-in is not active yet — tap Enable. If it fails, allow location All the time, notifications, and Unrestricted battery.',
        );
      }
      const anyGap =
        needsLocation ||
        needsBackgroundLocation ||
        needsNotifications ||
        needsBattery ||
        (saved && !backgroundArmed);
      if (!anyGap && saved) {
        permissionLines.push('Permissions look ready on this phone.');
      }
    } catch {
      permissionLines.push('Could not read permission status. Tap Enable to try again.');
    }
  } else if (kind === 'desktop') {
    permissionLines.push(
      'After you enable, this computer can check in while the app or tray icon is running.',
    );
  } else {
    permissionLines.push('Use the Android app or desktop app to turn on automatic check-in.');
  }

  return {
    kind,
    platformLabel: platformLabel(),
    saved,
    backgroundArmed,
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
 * Returns ok only when background is armed (Android) or device token saved (desktop).
 * Never returns a soft “tap Enable again” success when setup did not finish.
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
        'Automatic check-in needs the Android app or desktop app. The browser and iOS cannot stay enrolled.',
      warnings,
    };
  }

  if (kind === 'android') {
    const whileUsing = await requestWhileUsingLocation();
    if (!whileUsing.ok) {
      return {
        ok: false,
        error: friendlyAutoAttendanceError(
          whileUsing.detail,
          'Allow location while using the app, then tap Enable again.',
        ),
        warnings,
      };
    }
    const always = await requestAlwaysLocation();
    if (!always.ok) {
      warnings.push(always.detail);
    }
    const notif = await requestNativeNotifications();
    if (!notif.ok) {
      warnings.push(notif.detail);
    }
    try {
      const snap = await getNativePermissionSnapshot();
      if (snap.batteryUnrestricted === false) {
        warnings.push(
          'Set battery use to Unrestricted for Scorr so automatic check-in is not paused.',
        );
      }
    } catch {
      /* optional */
    }
  }

  const reg = await registerAttendanceDevice(packageVersion());
  if (!reg.ok || !reg.device_token) {
    return {
      ok: false,
      error: friendlyAutoAttendanceError(
        reg.error,
        'Couldn’t enable automatic check-in. Try again.',
      ),
      warnings,
    };
  }

  clearSetupProgress();

  if (kind === 'android') {
    try {
      await startNativeAttendancePings();
    } catch (e) {
      return {
        ok: false,
        error: friendlyAutoAttendanceError(
          e,
          'Background check-in failed to start. Check location (All the time), notifications, and battery, then tap Enable.',
        ),
        warnings,
      };
    }
    const armed = await isNativeAutoAttendanceArmed();
    if (!armed) {
      const blocker =
        warnings[0] ||
        'Background check-in did not activate. Open App settings → allow location All the time and notifications, set battery to Unrestricted, then tap Enable.';
      return {
        ok: false,
        error: blocker,
        warnings,
      };
    }
    // Armed — permission gaps are warnings, not a fake “almost done” success.
    return { ok: true, warnings };
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
      error: friendlyAutoAttendanceError(
        e,
        'Could not turn off on the server; this device was cleared locally.',
      ),
    };
  }

  await clearDesktopAttendanceToken();
  clearSetupProgress();
  return { ok: true };
}

export { openNativeAppSettings, openNativeBatterySettings };

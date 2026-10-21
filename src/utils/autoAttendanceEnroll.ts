/**
 * Settings → save / remove this device for background auto attendance
 * (Android FGS + iOS geofence + desktop Electron heartbeat). Browser / Home Screen: not offered.
 */
import { isNewerVersion, packageVersion } from './appUpdate';
import {
  clearLocalAttendanceEnrollment,
  disableAutoAttendanceOnDevice,
  fetchAttendanceSchedule,
  friendlyAutoAttendanceError,
  getAttendanceDeviceToken,
  PHONE_OPT_IN_TEXT,
  LAPTOP_OPT_IN_TEXT,
  registerAttendanceDevice,
} from './attendanceDevice';
import {
  isNativeAutoAttendanceArmed,
  startNativeAttendancePings,
} from './attendanceNativePing';
import {
  batteryTips,
  clearSetupProgress,
  fetchSetupStatus,
  getNativePermissionSnapshot,
  openNativeAppSettings,
  openNativeBatterySettings,
} from './autoAttendanceSetup';
import { DESKTOP_LINUX_DEB_PATH, DESKTOP_WIN_PATH } from './appStoreLinks';
import {
  clientAttendancePlatform,
  hasScorrDesktopBridge,
  hasScorrDesktopApi,
  isAndroidApp,
  isBrowserInstalledShell,
  isDesktopApp,
  isElectronShell,
  isIosApp,
  isIosHomeScreen,
} from './nativePlatform';

/**
 * Minimum Electron binary (not the web bundle).
 * Align with published GitHub Releases that include a working preload bridge:
 * Windows 1.3.40+ (Enable arming); Linux 1.3.39+ (deb/AppImage on that tag).
 * Do not raise past what is actually published for that OS.
 */
function minDesktopBinary(): string {
  const p = clientAttendancePlatform();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (p === 'windows' || /windows/i.test(ua)) return '1.3.40';
  return '1.3.39';
}

/** Incomplete/ancient preload: prefer reinstall + quit tray over “version too low” alone. */
function desktopBridgeIncompleteHint(pkgLabel: string): string {
  return `This Scorr Desktop is missing auto check-in APIs (common on old 1.3.4 shells). Quit Scorr completely (tray icon too), install ${minDesktopBinary()}+ (${pkgLabel}) from GitHub Releases, open Scorr from Applications / Start Menu, then tap Enable.`;
}

/** Platform-aware install hint (Windows → Setup.exe, Linux → .deb). */
function desktopInstallPackageHint(): { label: string; href: string } {
  const p = clientAttendancePlatform();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const isWin = p === 'windows' || /windows/i.test(ua);
  if (isWin) {
    return { label: 'Scorr-Setup.exe', href: DESKTOP_WIN_PATH };
  }
  return { label: 'Scorr.deb', href: DESKTOP_LINUX_DEB_PATH };
}

/** Electron app.getVersion() via preload — never the website packageVersion. */
async function desktopBinaryVersion(): Promise<string | null> {
  try {
    const desk = typeof window !== 'undefined' ? window.scorrDesktop : undefined;
    if (!desk?.getAppVersion) return null;
    const v = await Promise.resolve(desk.getAppVersion());
    const s = v == null ? '' : String(v).trim();
    return s || null;
  } catch {
    return null;
  }
}

function desktopBinaryTooOld(ver: string | null): boolean {
  const min = minDesktopBinary();
  if (!ver) return true;
  if (ver === min) return false;
  return isNewerVersion(min, ver);
}

export type AutoAttendanceClientKind = 'android' | 'ios' | 'desktop' | 'unsupported';

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
  /** Human line: in window now, or when the next [start−1h, end] opens. */
  windowHint: string | null;
};

function clientKind(): AutoAttendanceClientKind {
  if (isAndroidApp()) return 'android';
  if (isIosApp()) return 'ios';
  // Any Electron / scorr-desktop window (including ancient 1.3.4 shells).
  if (isDesktopApp() || isElectronShell()) return 'desktop';
  return 'unsupported';
}

function platformLabel(): string {
  const p = clientAttendancePlatform();
  if (p === 'android') return 'Android';
  if (p === 'windows' || p === 'linux') {
    const os = p === 'windows' ? 'Windows' : 'Linux';
    if (hasScorrDesktopBridge()) return `${os} desktop`;
    if (hasScorrDesktopApi() || isElectronShell()) {
      return `${os} desktop (bridge missing — reinstall ${minDesktopBinary()}+)`;
    }
    return `${os} desktop (install required)`;
  }
  if (p === 'ios' || isIosApp() || isIosHomeScreen()) return 'iOS';
  if (isBrowserInstalledShell()) return 'Browser app shortcut (not Scorr desktop)';
  if (isElectronShell()) return 'Desktop shell (bridge missing — reinstall)';
  return 'Browser';
}

export function isAutoAttendanceSaveSupported(): boolean {
  return clientKind() !== 'unsupported';
}

function formatLocalWindowInstant(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** Explain [shift start − 1h, shift end] from attendance-schedule payload. */
export function describeAutoAttendanceWindow(sched: Record<string, unknown> | null): string | null {
  if (!sched || sched.ok === false) return null;
  const windows = Array.isArray(sched.windows) ? (sched.windows as Record<string, unknown>[]) : [];
  const nowMs = sched.server_now_utc ? Date.parse(String(sched.server_now_utc)) : Date.now();
  const now = Number.isNaN(nowMs) ? Date.now() : nowMs;

  let active: Record<string, unknown> | null = null;
  let next: Record<string, unknown> | null = null;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const w of windows) {
    const start = Date.parse(String(w.window_start_utc || ''));
    const end = Date.parse(String(w.window_end_utc || ''));
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (now >= start && now <= end) {
      active = w;
      break;
    }
    if (start > now && start < nextStart) {
      nextStart = start;
      next = w;
    }
  }

  if (active) {
    const endLabel = formatLocalWindowInstant(String(active.window_end_utc || ''));
    const name = active.shift_name ? String(active.shift_name) : 'your shift';
    return endLabel
      ? `In window for ${name} — auto check-in until ${endLabel}.`
      : `In window for ${name} — auto check-in is running.`;
  }
  if (next) {
    const startLabel = formatLocalWindowInstant(String(next.window_start_utc || ''));
    const name = next.shift_name ? String(next.shift_name) : 'your shift';
    return startLabel
      ? `Waiting for ${name} — auto starts ${startLabel} (1 hour before shift start).`
      : `Waiting for ${name} — auto starts 1 hour before shift start.`;
  }
  return 'No shift window in the next few days — ask your manager to assign a shift.';
}

/**
 * Push device token into Electron main and arm the schedule/heartbeat loop.
 * Returns true when main accepted the token (same bar as Android “armed”).
 */
async function ensureDesktopMainArmed(token: string | null): Promise<boolean> {
  if (!token || !isElectronShell()) return false;
  const desk = typeof window !== 'undefined' ? window.scorrDesktop : undefined;
  // Ancient shells (e.g. 1.3.4) expose isDesktop but not saveAttendanceToken — cannot arm.
  if (!hasScorrDesktopBridge() || !desk?.saveAttendanceToken) {
    console.warn(
      `[scorr-att] desktop shell outdated or bridge incomplete — need Scorr Desktop ${minDesktopBinary()}+`,
    );
    return false;
  }
  try {
    const saved: unknown = await Promise.resolve(desk.saveAttendanceToken(token));
    // Accept: true | { ok:true } | { hasToken:true }. Reject only explicit false / ok:false.
    let mainHas = false;
    if (saved === true) {
      mainHas = true;
    } else if (saved && typeof saved === 'object') {
      const row = saved as { ok?: boolean; hasToken?: boolean };
      mainHas = row.ok === true || row.hasToken === true;
    } else if (saved !== false && saved != null && saved !== undefined) {
      // Non-boolean legacy truthy
      mainHas = Boolean(saved);
    }
    if (!mainHas && desk.hasAttendanceToken) {
      mainHas = Boolean(await Promise.resolve(desk.hasAttendanceToken()));
    }
    // Tray / login-item — best effort; token in main is enough to be “armed”.
    // Cap wait: Windows geolocation inside prepare must never block Enable.
    if (mainHas && desk.prepareAutoAttendance) {
      try {
        await Promise.race([
          Promise.resolve(desk.prepareAutoAttendance()),
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 2500);
          }),
        ]);
      } catch {
        /* ignore */
      }
    }
    return mainHas;
  } catch (e) {
    console.warn('[scorr-att] ensureDesktopMainArmed failed', e);
    return false;
  }
}

export async function getAutoAttendanceSaveStatus(): Promise<AutoAttendanceSaveStatus> {
  const kind = clientKind();
  const token = await getAttendanceDeviceToken();
  const saved = Boolean(token);
  let backgroundArmed =
    kind === 'android' || kind === 'ios'
      ? (saved ? await isNativeAutoAttendanceArmed() : false)
      : saved;
  // Desktop: Active when main process has the token (tray can heartbeat), like Android FGS armed.
  if (kind === 'desktop' && saved) {
    backgroundArmed = await ensureDesktopMainArmed(token);
  }
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

  if (kind === 'android' || kind === 'ios') {
    try {
      const snap = await getNativePermissionSnapshot();
      const locGranted = snap.location === 'granted' || snap.coarseLocation === 'granted';
      needsLocation = !locGranted;
      needsBackgroundLocation = snap.backgroundLocation !== 'granted';
      needsNotifications = snap.notifications !== 'granted' && snap.notifications !== 'authorized';
      if (kind === 'android' && snap.batteryUnrestricted === false) {
        needsBattery = true;
        batteryLines = batteryTips(String(snap.manufacturer || ''));
      }
      if (needsLocation) {
        permissionLines.push('Allow location while using the app for office-area check-in.');
      }
      if (needsBackgroundLocation) {
        permissionLines.push(
          kind === 'ios'
            ? 'Allow Location → Always so check-in works when Scorr is closed.'
            : 'Allow location “All the time” so check-in works when Scorr is closed.',
        );
      }
      if (needsNotifications) {
        permissionLines.push('Allow notifications so automatic check-in can keep running.');
      }
      if (needsBattery) {
        permissionLines.push('Set battery use to Unrestricted so automatic check-in is not paused.');
      }
      if (saved && !backgroundArmed) {
        permissionLines.push(
          kind === 'ios'
            ? 'Background check-in is not active yet — tap Enable. If it fails, set Location to Always and allow notifications.'
            : 'Background check-in is not active yet — tap Enable. If it fails, allow location All the time, notifications, and Unrestricted battery.',
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
      'After Enable: no daily login needed. Keep the tray icon running (or start at login) during your shift window.',
    );
    permissionLines.push('Office Wi‑Fi checks you in first; otherwise office radius with location.');
    if (!hasScorrDesktopBridge()) {
      const pkg = desktopInstallPackageHint();
      permissionLines.push(
        hasScorrDesktopApi() || isElectronShell()
          ? `Desktop bridge missing (no auto check-in APIs). Quit tray, install ${minDesktopBinary()}+ ${pkg.label}, reopen, then Enable.`
          : `Install Scorr Desktop ${minDesktopBinary()}+ (${pkg.label}), then open it from the Start Menu / Applications and tap Enable.`,
      );
    } else if (saved && !backgroundArmed) {
      permissionLines.push(
        'Could not save the device token into the desktop app — quit Scorr fully and open it again, then tap Enable.',
      );
    }
  } else {
    permissionLines.push(
      'Use the Android, iOS, or desktop app to turn on automatic check-in.',
    );
  }

  let windowHint: string | null = null;
  if (saved) {
    try {
      const { fetchAttendanceSchedule } = await import('./attendanceDevice');
      const sched = await fetchAttendanceSchedule();
      windowHint = describeAutoAttendanceWindow(sched);
    } catch {
      windowHint = null;
    }
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
    windowHint,
  };
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
        'Automatic check-in needs the Android, iOS, or desktop app. The browser cannot stay enrolled.',
      warnings,
    };
  }

  if (kind === 'android') {
    const { requestAllAndroidAutoAttendanceAccess } = await import('./autoAttendanceSetup');
    const access = await requestAllAndroidAutoAttendanceAccess();
    warnings.push(...access.warnings);
    if (!access.ok) {
      return {
        ok: false,
        error: friendlyAutoAttendanceError(
          access.error,
          'Allow location (All the time), notifications, Wi‑Fi, and unrestricted battery, then tap Enable again.',
        ),
        warnings,
      };
    }
  }

  if (kind === 'ios') {
    const { requestAllIosAutoAttendanceAccess } = await import('./autoAttendanceSetup');
    const access = await requestAllIosAutoAttendanceAccess();
    warnings.push(...access.warnings);
    if (!access.ok) {
      return {
        ok: false,
        error: friendlyAutoAttendanceError(
          access.error,
          'Allow Location → Always and notifications, then tap Enable again.',
        ),
        warnings,
      };
    }
  }

  if (kind === 'desktop') {
    // Require a real Electron bridge BEFORE register. Otherwise Windows/Linux can
    // register with the website version (looks like 1.3.x in DB) while main never
    // gets the token → Enable error + zero heartbeats.
    const pkg = desktopInstallPackageHint();
    if (!hasScorrDesktopBridge()) {
      return {
        ok: false,
        error:
          hasScorrDesktopApi() || isElectronShell()
            ? desktopBridgeIncompleteHint(pkg.label)
            : `Desktop auto check-in needs Scorr Desktop ${minDesktopBinary()}+. Install ${pkg.label} from GitHub Releases, then open it from the Start Menu / Applications.`,
        warnings,
      };
    }
    const electronVer = await desktopBinaryVersion();
    if (desktopBinaryTooOld(electronVer)) {
      return {
        ok: false,
        error: `This Scorr Desktop is ${electronVer || 'unknown'} — install ${minDesktopBinary()}+ (${pkg.label}) from GitHub Releases, quit the old app fully, then tap Enable.`,
        warnings,
      };
    }
    const { requestAllDesktopAutoAttendanceAccess } = await import('./autoAttendanceSetup');
    const access = await requestAllDesktopAutoAttendanceAccess();
    warnings.push(...access.warnings);
  }

  // 1) Register device + persist token first (before schedule / FGS / desktop heartbeat).
  // Desktop: register with Electron binary version (not the web bundle) so DB matches the shell.
  let registerVersion = packageVersion();
  if (kind === 'desktop') {
    registerVersion = (await desktopBinaryVersion()) || packageVersion();
  }
  const reg = await registerAttendanceDevice(registerVersion);
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

  // 2) Load schedule after token exists (device-token edge path). Clear copy if shift/office missing.
  try {
    const schedule = await fetchAttendanceSchedule();
    const windows = Array.isArray(schedule?.windows) ? schedule!.windows : [];
    const zones = Array.isArray(schedule?.zones) ? schedule!.zones : [];
    if (schedule && schedule.ok === false) {
      const reason = String(schedule.reason || schedule.message || '');
      if (/invalid|revoked|missing_token|platform_disabled|user_gone|disabled/i.test(reason)) {
        return {
          ok: false,
          error:
            'Automatic check-in is not allowed for this account or device. Ask your admin, then tap Enable again.',
          warnings,
        };
      }
    } else if (schedule) {
      if (windows.length === 0) {
        warnings.push(
          'No shift schedule found for the next week. Ask your admin to assign a shift, or check-in will wait until a shift exists.',
        );
      }
      if (zones.length === 0) {
        warnings.push(
          'No office location is assigned to you. Ask your admin to assign an office before automatic check-in can fire.',
        );
      }
    }
  } catch {
    /* schedule optional for arming — native/desktop will retry */
  }

  // 3) Arm Android FGS / iOS geofence / desktop heartbeat after register.
  if (kind === 'android' || kind === 'ios') {
    try {
      await startNativeAttendancePings();
    } catch (e) {
      return {
        ok: false,
        error: friendlyAutoAttendanceError(
          e,
          kind === 'ios'
            ? 'Background check-in failed to start. Set Location to Always and allow notifications, then tap Enable.'
            : 'Background check-in failed to start. Check location (All the time), notifications, and battery, then tap Enable.',
        ),
        warnings,
      };
    }
    const armed = await isNativeAutoAttendanceArmed();
    if (!armed) {
      const blocker =
        warnings[0] ||
        (kind === 'ios'
          ? 'Background check-in did not activate. Open Settings → Scorr → Location → Always, allow notifications, then tap Enable.'
          : 'Background check-in did not activate. Open App settings → allow location All the time and notifications, set battery to Unrestricted, then tap Enable.');
      return {
        ok: false,
        error: blocker,
        warnings,
      };
    }
    return { ok: true, warnings };
  }

  if (kind === 'desktop') {
    await enableDesktopAutoLaunch();
    // Re-push token into main + arm heartbeats (same role as Android startNativeAttendancePings).
    const mainArmed = await ensureDesktopMainArmed(reg.device_token);
    if (!mainArmed) {
      const incomplete = !hasScorrDesktopBridge() && (hasScorrDesktopApi() || isElectronShell());
      const pkg = desktopInstallPackageHint();
      return {
        ok: false,
        error: incomplete
          ? desktopBridgeIncompleteHint(pkg.label)
          : hasScorrDesktopBridge()
            ? 'Could not arm background check-in. Quit Scorr fully (tray icon too), open Scorr from the Start Menu, then tap Enable.'
            : `Desktop auto check-in needs Scorr Desktop ${minDesktopBinary()}+. Install ${pkg.label} from GitHub Releases, then open it from the Start Menu / Applications.`,
        warnings,
      };
    }
  }

  return { ok: true, warnings };
}

export async function removeAccountFromAutoAttendance(): Promise<{
  ok: boolean;
  error?: string;
  /** Local token / heartbeat / FGS cleared — UI should show Off + Enable. */
  locallyCleared: boolean;
}> {
  const kind = clientKind();
  const disableKind = kind === 'desktop' ? 'laptop' : 'phone';

  try {
    await disableAutoAttendanceOnDevice(disableKind);
    clearSetupProgress();
    return { ok: true, locallyCleared: true };
  } catch (e) {
    // disableAutoAttendanceOnDevice already clears in finally; belt-and-suspenders.
    await clearLocalAttendanceEnrollment();
    clearSetupProgress();
    return {
      ok: false,
      locallyCleared: true,
      error: friendlyAutoAttendanceError(
        e,
        'Could not turn off on the server; this device was cleared locally. Tap Enable to add it again.',
      ),
    };
  }
}

export { openNativeAppSettings, openNativeBatterySettings };

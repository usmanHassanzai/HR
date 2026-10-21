import { supabaseUrl, supabaseAnonKey } from '../lib/supabaseConfig';
import { packageVersion } from './appUpdate';
import { AttendancePing } from './attendancePingPlugin';
import { isAndroidApp, isIosApp } from './nativePlatform';
import { getAttendanceDeviceToken } from './attendanceDevice';

function isNativeAutoAttendanceApp(): boolean {
  return isAndroidApp() || isIosApp();
}

const DEVICE_ID_KEY = 'scorr_attendance_device_id';
/** JS fallback when APK lacks isAutoAttendanceEnabled (live web + older native). */
const ARMED_FLAG_KEY = 'scorr_attendance_native_armed';

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

async function setArmedFlag(armed: boolean): Promise<void> {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    if (armed) {
      await Preferences.set({ key: ARMED_FLAG_KEY, value: '1' });
    } else {
      await Preferences.remove({ key: ARMED_FLAG_KEY });
    }
  } catch {
    /* ignore */
  }
  try {
    if (armed) localStorage.setItem(ARMED_FLAG_KEY, '1');
    else localStorage.removeItem(ARMED_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

async function readArmedFlag(): Promise<boolean> {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: ARMED_FLAG_KEY });
    if (value === '1') return true;
  } catch {
    /* fall through */
  }
  try {
    return localStorage.getItem(ARMED_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function pluginErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message || '');
  }
  return String(e || '');
}

function isPluginMethodMissing(e: unknown): boolean {
  const msg = pluginErrorMessage(e);
  return /not implemented|unimplemented|"?isAutoAttendanceEnabled"?.*(exist|available)|no such method|is not a function/i.test(
    msg,
  );
}

/**
 * Android / iOS Capacitor: auto check-in via device token + schedule window.
 * Throws when the plugin rejects so enroll UI can surface a real warning.
 */
export async function startNativeAttendancePings(): Promise<void> {
  if (!isNativeAutoAttendanceApp()) return;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase config — cannot start background check-in.');
  }
  const deviceToken = await getAttendanceDeviceToken();
  if (!deviceToken) {
    throw new Error('No device token saved — register this device first.');
  }
  const deviceId = await resolveDeviceId();
  const platformLabel = isIosApp() ? 'iOS' : 'Android';
  try {
    await AttendancePing.startAutoAttendance!({
      supabaseUrl,
      anonKey: supabaseAnonKey,
      deviceToken,
      deviceId,
      appVersion: packageVersion(),
    });
  } catch (e) {
    await setArmedFlag(false);
    const msg = pluginErrorMessage(e);
    if (/not implemented|unimplemented|no such method/i.test(msg)) {
      throw new Error(
        `This ${platformLabel} app build is outdated for automatic check-in. Update or reinstall Scorr, then tap Enable again.`,
      );
    }
    if (/Auto attendance not enabled/i.test(msg)) {
      throw new Error(
        'Background check-in did not save on this phone. Force-close Scorr, reopen, and tap Enable again.',
      );
    }
    if (/Schedule HTTP|schedule_fetch|Missing device credentials/i.test(msg)) {
      throw new Error(
        'Could not load your attendance schedule. Check network and that automatic check-in is allowed for your account, then tap Enable again.',
      );
    }
    if (/stop_tracking|revoked|disabled/i.test(msg)) {
      throw new Error(
        'Automatic check-in was turned off for this device on the server. Tap Enable to register again, or ask your admin.',
      );
    }
    if (/permission|notification|foreground service|startForeground/i.test(msg)) {
      throw new Error(
        isIosApp()
          ? 'iPhone blocked background check-in. Allow Location → Always and notifications for Scorr, then tap Enable.'
          : 'Android blocked background check-in. Allow location (All the time), notifications, and Unrestricted battery for Scorr, then tap Enable.',
      );
    }
    throw e instanceof Error ? e : new Error(msg || 'Failed to start background check-in.');
  }
  await setArmedFlag(true);
}

/**
 * True when native EncryptedSharedPreferences has token + enabled (FGS can arm).
 * Older APKs without isAutoAttendanceEnabled fall back to a JS flag set after a
 * successful startAutoAttendance (avoids forever “Needs setup” with live web).
 */
export async function isNativeAutoAttendanceArmed(): Promise<boolean> {
  if (!isNativeAutoAttendanceApp()) return false;
  try {
    const res = await AttendancePing.isAutoAttendanceEnabled!();
    const enabled = Boolean(res?.enabled);
    if (enabled) await setArmedFlag(true);
    else if (res && res.enabled === false) await setArmedFlag(false);
    return enabled;
  } catch (e) {
    if (isPluginMethodMissing(e)) {
      const token = await getAttendanceDeviceToken();
      return Boolean(token) && (await readArmedFlag());
    }
    return false;
  }
}

export async function refreshNativeAttendanceSession(): Promise<void> {
  if (!isNativeAutoAttendanceApp()) return;
  const deviceToken = await getAttendanceDeviceToken();
  if (!deviceToken) return;
  try {
    await AttendancePing.syncSchedule?.();
  } catch {
    /* ignore */
  }
}

export async function stopNativeAttendancePings(): Promise<void> {
  if (!isNativeAutoAttendanceApp()) return;
  await setArmedFlag(false);
  try {
    await AttendancePing.stopAutoAttendance?.();
  } catch {
    try {
      await AttendancePing.stop?.();
    } catch {
      /* ignore */
    }
  }
}

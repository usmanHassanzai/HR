/**
 * Remember-me login credentials for installed apps only.
 * Password is NEVER stored in localStorage or Capacitor Preferences.
 * - Electron: safeStorage (encrypted file)
 * - Android: EncryptedSharedPreferences (Keystore)
 * - iOS: Keychain
 * Web browser: unchanged (browser password manager).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { isAppShell, isDesktopApp, isNativeApp } from './nativePlatform';

const LEGACY_EMAIL_KEY = 'scorr_remember_login_email';
const LEGACY_PASSWORD_KEY = 'scorr_remember_login_password';

interface SecureLoginPlugin {
  saveLoginCredentials(options: { email: string; password: string }): Promise<void>;
  loadLoginCredentials(): Promise<{ email?: string | null; password?: string | null }>;
  clearLoginCredentials(): Promise<void>;
}

const AttendancePing = registerPlugin<SecureLoginPlugin>('AttendancePing');

type DesktopApi = {
  saveLoginCredentials?: (email: string, password: string) => Promise<boolean> | boolean;
  loadLoginCredentials?: () => Promise<{ email: string; password: string } | null> | { email: string; password: string } | null;
  clearLoginCredentials?: () => Promise<boolean> | boolean;
};

function desktopApi(): DesktopApi | undefined {
  return (window as unknown as { scorrDesktop?: DesktopApi }).scorrDesktop;
}

/** Wipe any plaintext password previously saved by the insecure remember-me path. */
export async function migrateClearInsecureRememberedLogin(): Promise<void> {
  try {
    localStorage.removeItem(LEGACY_EMAIL_KEY);
    localStorage.removeItem(LEGACY_PASSWORD_KEY);
  } catch {
    /* ignore */
  }
  try {
    await Preferences.remove({ key: LEGACY_EMAIL_KEY });
    await Preferences.remove({ key: LEGACY_PASSWORD_KEY });
  } catch {
    /* ignore */
  }
}

export async function loadRememberedLogin(): Promise<{ email: string; password: string } | null> {
  if (!isAppShell()) return null;
  await migrateClearInsecureRememberedLogin();

  try {
    if (isDesktopApp()) {
      const raw = await desktopApi()?.loadLoginCredentials?.();
      if (raw?.email && raw?.password) return { email: raw.email, password: raw.password };
      return null;
    }
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      const raw = await AttendancePing.loadLoginCredentials();
      const email = (raw?.email || '').trim();
      const password = raw?.password || '';
      if (email && password) return { email, password };
    }
  } catch {
    /* plugin / ipc unavailable */
  }
  return null;
}

export async function saveRememberedLogin(email: string, password: string): Promise<void> {
  if (!isAppShell()) return;
  const trimmed = email.trim();
  if (!trimmed || !password) return;
  await migrateClearInsecureRememberedLogin();

  try {
    if (isDesktopApp()) {
      await desktopApi()?.saveLoginCredentials?.(trimmed, password);
      return;
    }
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      await AttendancePing.saveLoginCredentials({ email: trimmed, password });
    }
  } catch {
    /* ignore */
  }
}

export async function clearRememberedLogin(): Promise<void> {
  await migrateClearInsecureRememberedLogin();
  try {
    if (isDesktopApp()) {
      await desktopApi()?.clearLoginCredentials?.();
      return;
    }
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      await AttendancePing.clearLoginCredentials();
    }
  } catch {
    /* ignore */
  }
}

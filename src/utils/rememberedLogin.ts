/**
 * Remember-me login credentials for installed apps only.
 * Password is NEVER stored in plaintext localStorage.
 * Priority:
 * 1. Electron: safeStorage / AES file via scorrDesktop
 * 2. Android/iOS: Keystore / Keychain via AttendancePing
 * 3. App-shell fallback: AES-GCM in IndexedDB (covers older desktop shells
 *    without login IPC, and PWA standalone)
 * Web browser (marketing site): no password persistence (browser password manager).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { isAppShell, isDesktopApp, isNativeApp } from './nativePlatform';

const LEGACY_EMAIL_KEY = 'scorr_remember_login_email';
const LEGACY_PASSWORD_KEY = 'scorr_remember_login_password';
const REMEMBER_FLAG_KEY = 'scorr_remember_me_enabled';
const VAULT_DB = 'scorr-remember-login';
const VAULT_STORE = 'vault';
const VAULT_KEY_ID = 'device-key';
const VAULT_CREDS_ID = 'credentials';

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

function hasDesktopLoginApi(): boolean {
  const api = desktopApi();
  return Boolean(api?.saveLoginCredentials && api?.loadLoginCredentials);
}

async function setRememberFlag(enabled: boolean): Promise<void> {
  try {
    if (enabled) {
      await Preferences.set({ key: REMEMBER_FLAG_KEY, value: '1' });
      localStorage.setItem(REMEMBER_FLAG_KEY, '1');
    } else {
      await Preferences.remove({ key: REMEMBER_FLAG_KEY });
      localStorage.removeItem(REMEMBER_FLAG_KEY);
    }
  } catch {
    /* ignore */
  }
}

export async function isRememberMeEnabled(): Promise<boolean> {
  try {
    const { value } = await Preferences.get({ key: REMEMBER_FLAG_KEY });
    if (value === '1') return true;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(REMEMBER_FLAG_KEY) === '1';
  } catch {
    return false;
  }
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

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        db.createObjectStore(VAULT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, 'readonly');
    const req = tx.objectStore(VAULT_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, 'readwrite');
    tx.objectStore(VAULT_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDel(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, 'readwrite');
    tx.objectStore(VAULT_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getOrCreateVaultKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await idbGet<ArrayBuffer>(db, VAULT_KEY_ID);
  if (existing) {
    return crypto.subtle.importKey('raw', existing, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', key);
  await idbSet(db, VAULT_KEY_ID, raw);
  return key;
}

async function saveVaultCredentials(email: string, password: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || !crypto?.subtle) return false;
  try {
    const db = await openVaultDb();
    try {
      const key = await getOrCreateVaultKey(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify({ email, password }));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
      await idbSet(db, VAULT_CREDS_ID, {
        iv: Array.from(iv),
        data: Array.from(new Uint8Array(cipher)),
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function loadVaultCredentials(): Promise<{ email: string; password: string } | null> {
  if (typeof indexedDB === 'undefined' || !crypto?.subtle) return null;
  try {
    const db = await openVaultDb();
    try {
      const packed = await idbGet<{ iv: number[]; data: number[] }>(db, VAULT_CREDS_ID);
      if (!packed?.iv?.length || !packed?.data?.length) return null;
      const key = await getOrCreateVaultKey(db);
      const iv = new Uint8Array(packed.iv);
      const data = new Uint8Array(packed.data);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as { email?: string; password?: string };
      if (parsed.email && parsed.password) return { email: parsed.email, password: parsed.password };
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function clearVaultCredentials(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openVaultDb();
    try {
      await idbDel(db, VAULT_CREDS_ID);
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}

async function loadFromDesktop(): Promise<{ email: string; password: string } | null> {
  if (!hasDesktopLoginApi()) return null;
  const raw = await desktopApi()?.loadLoginCredentials?.();
  if (raw?.email && raw?.password) return { email: raw.email, password: raw.password };
  return null;
}

async function loadFromNative(): Promise<{ email: string; password: string } | null> {
  if (!(isNativeApp() || Capacitor.isNativePlatform())) return null;
  const raw = await AttendancePing.loadLoginCredentials();
  const email = (raw?.email || '').trim();
  const password = raw?.password || '';
  if (email && password) return { email, password };
  return null;
}

async function saveToDesktop(email: string, password: string): Promise<boolean> {
  if (!hasDesktopLoginApi()) return false;
  const ok = await desktopApi()!.saveLoginCredentials!(email, password);
  return ok !== false;
}

async function saveToNative(email: string, password: string): Promise<boolean> {
  if (!(isNativeApp() || Capacitor.isNativePlatform())) return false;
  await AttendancePing.saveLoginCredentials({ email, password });
  return true;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function loadRememberedLogin(): Promise<{ email: string; password: string } | null> {
  if (!isAppShell()) return null;
  await migrateClearInsecureRememberedLogin();

  // Native bridges can lag a tick after WebView resume / session expiry remount.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const candidates: Array<{ email: string; password: string } | null> = [];
      if (isDesktopApp() || hasDesktopLoginApi()) {
        candidates.push(await loadFromDesktop());
      }
      if (isNativeApp() || Capacitor.isNativePlatform()) {
        candidates.push(await loadFromNative());
      }
      candidates.push(await loadVaultCredentials());
      const hit = candidates.find((c) => c?.email && c?.password);
      if (hit) return hit;
    } catch {
      /* retry */
    }
    if (attempt < 4) await sleep(150 * (attempt + 1));
  }
  return null;
}

const LAST_EMAIL_KEY = 'scorr_last_login_email';

/** Plain email hint for autocomplete (never stores password). */
export async function loadLastLoginEmail(): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key: LAST_EMAIL_KEY });
    if (value?.trim()) return value.trim();
  } catch {
    /* ignore */
  }
  try {
    const v = localStorage.getItem(LAST_EMAIL_KEY);
    return v?.trim() || null;
  } catch {
    return null;
  }
}

async function saveLastLoginEmail(email: string): Promise<void> {
  const trimmed = email.trim();
  if (!trimmed) return;
  try {
    await Preferences.set({ key: LAST_EMAIL_KEY, value: trimmed });
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(LAST_EMAIL_KEY, trimmed);
  } catch {
    /* ignore */
  }
}

export async function saveRememberedLogin(email: string, password: string): Promise<void> {
  if (!isAppShell()) return;
  const trimmed = email.trim();
  if (!trimmed || !password) return;
  await migrateClearInsecureRememberedLogin();
  await saveLastLoginEmail(trimmed);

  let saved = false;
  try {
    // Always write every available store so session-expiry remount can recover
    // even if one bridge (safeStorage / Keystore / IndexedDB) fails.
    if (isDesktopApp() || hasDesktopLoginApi()) {
      saved = (await saveToDesktop(trimmed, password)) || saved;
    }
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      try {
        saved = (await saveToNative(trimmed, password)) || saved;
      } catch {
        /* continue */
      }
    }
    saved = (await saveVaultCredentials(trimmed, password)) || saved;
  } catch {
    try {
      saved = (await saveVaultCredentials(trimmed, password)) || saved;
    } catch {
      /* ignore */
    }
  }

  if (saved) await setRememberFlag(true);
}

export async function clearRememberedLogin(): Promise<void> {
  await migrateClearInsecureRememberedLogin();
  await setRememberFlag(false);
  try {
    await Preferences.remove({ key: LAST_EMAIL_KEY });
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(LAST_EMAIL_KEY);
  } catch {
    /* ignore */
  }
  try {
    if (hasDesktopLoginApi()) {
      await desktopApi()?.clearLoginCredentials?.();
    }
  } catch {
    /* ignore */
  }
  try {
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      await AttendancePing.clearLoginCredentials();
    }
  } catch {
    /* ignore */
  }
  await clearVaultCredentials();
}

/**
 * Trusted-device MFA skip (7-day default).
 * Web: HttpOnly SameSite=Strict cookie via same-origin /api/trusted-device.
 * Capacitor: Keystore/Keychain via AttendancePing plugin.
 * Electron: safeStorage via scorrDesktop bridge.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from '../lib/supabase';
import { isAppShell, isDesktopApp, isNativeApp } from './nativePlatform';

const DEVICE_ID_KEY = 'scorr_trusted_device_id';
const TOKEN_KEY = 'scorr_trusted_device_token';
const COOKIE_API = '/api/trusted-device';

export type TrustedDeviceRow = {
  id: string;
  device_id: string;
  platform: string;
  label?: string | null;
  user_agent?: string | null;
  created_at: string;
  expires_at: string;
  last_used_at?: string | null;
};

interface TrustedDevicePlugin {
  saveTrustedDeviceToken(options: { token: string }): Promise<void>;
  loadTrustedDeviceToken(): Promise<{ token?: string | null }>;
  clearTrustedDeviceToken(): Promise<void>;
}

const AttendancePing = registerPlugin<TrustedDevicePlugin>('AttendancePing');

type DesktopApi = {
  saveTrustedDeviceToken?: (token: string) => Promise<boolean> | boolean;
  loadTrustedDeviceToken?: () => Promise<string | null> | string | null;
  clearTrustedDeviceToken?: () => Promise<boolean> | boolean;
};

function desktopApi(): DesktopApi | undefined {
  return (window as unknown as { scorrDesktop?: DesktopApi }).scorrDesktop;
}

/** Default trust checkbox: ON for installed apps, OFF for shared/public browsers. */
export function defaultTrustThisDeviceChecked(): boolean {
  if (isAppShell() || isNativeApp() || isDesktopApp()) return true;
  try {
    if (navigator.webdriver) return false;
    // Rough shared-kiosk heuristic
    if ((navigator as Navigator & { deviceMemory?: number }).deviceMemory === 0.5) return false;
  } catch {
    /* ignore */
  }
  return false;
}

export function detectTrustedPlatform(): string {
  if (Capacitor.getPlatform() === 'android') return 'android';
  if (Capacitor.getPlatform() === 'ios') return 'ios';
  if (isDesktopApp()) {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('mac')) return 'macos';
    return 'linux';
  }
  return 'web';
}

export async function getOrCreateTrustedDeviceId(): Promise<string> {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

async function storeTokenLocal(token: string): Promise<void> {
  try {
    if (isDesktopApp()) {
      await desktopApi()?.saveTrustedDeviceToken?.(token);
      return;
    }
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      await AttendancePing.saveTrustedDeviceToken({ token });
      return;
    }
  } catch {
    /* fall through */
  }
  // Web: prefer HttpOnly cookie via /api/trusted-device. Fallback localStorage when
  // the same-origin proxy is unavailable (e.g. prebuilt dist-only deploy).
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

async function loadTokenLocal(): Promise<string | null> {
  try {
    if (isDesktopApp()) {
      const t = await desktopApi()?.loadTrustedDeviceToken?.();
      return t || null;
    }
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      const raw = await AttendancePing.loadTrustedDeviceToken();
      return (raw?.token || '').trim() || null;
    }
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function clearTrustedDeviceLocal(): Promise<void> {
  try {
    if (isDesktopApp()) await desktopApi()?.clearTrustedDeviceToken?.();
  } catch {
    /* ignore */
  }
  try {
    if (isNativeApp() || Capacitor.isNativePlatform()) {
      await AttendancePing.clearTrustedDeviceToken();
    }
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function useCookieProxy(): boolean {
  // Same-origin API only on http(s) web (not capacitor:// or file://)
  if (isNativeApp() || isDesktopApp()) return false;
  try {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
  } catch {
    return false;
  }
}

async function invokeTrustedDevice<T>(
  action: string,
  extra: Record<string, unknown> = {},
  opts?: { token?: string | null },
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const access = sessionData.session?.access_token;
  if (!access) throw new Error('Not signed in.');

  const device_id = await getOrCreateTrustedDeviceId();
  const payload = {
    action,
    device_id,
    platform: detectTrustedPlatform(),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    ...extra,
    ...(opts?.token ? { token: opts.token } : {}),
  };

  if (useCookieProxy() && (action === 'issue' || action === 'verify' || action === 'revoke' || action === 'revoke_all' || action === 'clear_cookie')) {
    try {
      const res = await fetch(COOKIE_API, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok || res.status === 403 || res.status === 400) {
        const body = await res.json().catch(() => ({}));
        if (body?.error && res.status >= 400) throw new Error(String(body.error));
        // Cookie set by proxy — drop any plaintext fallback.
        if (body?.ok && (action === 'issue' || action === 'verify')) {
          try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        }
        return body as T;
      }
      // 404 / 5xx → fall through to edge function
    } catch (e) {
      if (e instanceof Error && e.message && !/Failed to fetch|NetworkError|404/i.test(e.message)) {
        // Propagate business errors from proxy
        if (!/fetch|network|404|502|503/i.test(e.message)) throw e;
      }
    }
  }

  const { data, error } = await supabase.functions.invoke('trusted_device', { body: payload });
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error));
  }
  if (error) {
    const ctx = error as { context?: Response };
    try {
      const body = ctx.context ? await ctx.context.json() : null;
      if (body?.error) throw new Error(String(body.error));
    } catch (parsed) {
      if (parsed instanceof Error && parsed.message !== error.message) throw parsed;
    }
    throw new Error(error.message || 'Could not reach trusted device service.');
  }
  return data as T;
}

export async function canTrustThisDevice(): Promise<{ allowed: boolean; days: number }> {
  try {
    const res = await invokeTrustedDevice<{ allowed?: boolean; days?: number }>('can_trust');
    return { allowed: Boolean(res.allowed), days: Number(res.days || 0) };
  } catch {
    return { allowed: false, days: 0 };
  }
}

export async function issueTrustedDevice(label?: string): Promise<{ ok: boolean; days?: number }> {
  const res = await invokeTrustedDevice<{
    ok?: boolean;
    token?: string;
    days?: number;
    error?: string;
    allowed?: boolean;
  }>('issue', { label: label || undefined });
  if (res.token) await storeTokenLocal(res.token);
  return { ok: Boolean(res.ok), days: res.days };
}

/** After password login: if a valid trusted token exists, create MFA session grant. */
export async function tryVerifyTrustedDevice(): Promise<boolean> {
  const local = await loadTokenLocal();
  try {
    const res = await invokeTrustedDevice<{
      ok?: boolean;
      token?: string;
      reason?: string;
    }>('verify', {}, { token: local });
    if (res.token) await storeTokenLocal(res.token);
    if (!res.ok) {
      if (res.reason === 'invalid' || res.reason === 'expired' || res.reason === 'always_ask') {
        await clearTrustedDeviceLocal();
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function listTrustedDevices(): Promise<TrustedDeviceRow[]> {
  try {
    const { data, error } = await supabase.rpc('list_my_trusted_devices');
    if (!error && Array.isArray(data)) return data as TrustedDeviceRow[];
  } catch {
    /* fall through */
  }
  const res = await invokeTrustedDevice<{ devices?: TrustedDeviceRow[] }>('list');
  return res.devices || [];
}

export async function revokeTrustedDevice(id: string): Promise<void> {
  await invokeTrustedDevice('revoke', { id });
  // If we revoked the current device, clear local token
  await clearTrustedDeviceLocal();
}

export async function revokeAllTrustedDevices(): Promise<number> {
  const res = await invokeTrustedDevice<{ revoked?: number }>('revoke_all');
  await clearTrustedDeviceLocal();
  return Number(res.revoked || 0);
}

export async function adminRevokeAllTrustedDevices(userId: string): Promise<number> {
  const res = await invokeTrustedDevice<{ revoked?: number }>('admin_revoke_all', { user_id: userId });
  return Number(res.revoked || 0);
}

export async function fetchMfaTrustPolicy(): Promise<{
  mfa_trust_staff_days: number;
  mfa_trust_admin_days: number;
  can_edit: boolean;
} | null> {
  try {
    const { data, error } = await supabase.rpc('get_company_mfa_trust_policy');
    if (!error && data) {
      return data as {
        mfa_trust_staff_days: number;
        mfa_trust_admin_days: number;
        can_edit: boolean;
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function saveMfaTrustPolicy(staffDays: number, adminDays: number): Promise<void> {
  const { error } = await supabase.rpc('set_company_mfa_trust_policy', {
    p_staff_days: staffDays,
    p_admin_days: adminDays,
  });
  if (error) throw new Error(error.message);
}

/** Sign out and optionally forget this device's trust token. */
export async function forgetThisDeviceOnLogout(): Promise<void> {
  try {
    await invokeTrustedDevice('revoke_all').catch(() => undefined);
  } catch {
    /* ignore */
  }
  await clearTrustedDeviceLocal();
  if (useCookieProxy()) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const access = sessionData.session?.access_token;
      if (access) {
        await fetch(COOKIE_API, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${access}`,
          },
          body: JSON.stringify({ action: 'clear_cookie' }),
        });
      }
    } catch {
      /* ignore */
    }
  }
}

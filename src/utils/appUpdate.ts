/**
 * Cross-platform app update checks against /downloads/version.json
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isAndroidApp, isDesktopApp, isIosApp, isNativeApp } from './nativePlatform';

export const VERSION_JSON_URL = 'https://scorr.walfia.ai/downloads/version.json';
export const WEB_BUILD_META_URL = '/build-meta.json';

const CHECK_KEY = 'scorr-last-update-check';
const DISMISS_KEY = 'scorr-update-dismissed';

export type PlatformVersionInfo = {
  version?: string;
  versionName?: string;
  versionCode?: number;
  notes?: string;
  apkUrl?: string;
  setupUrl?: string;
  debUrl?: string;
  appImageUrl?: string;
  latestYmlUrl?: string;
  pwaUrl?: string;
  storeUrl?: string | null;
  minSupportedCode?: number;
  minSupportedVersion?: string;
};

export type VersionManifest = {
  generatedAt?: string;
  webBuildId?: string;
  mandatory?: boolean;
  notes?: string;
  android?: PlatformVersionInfo;
  windows?: PlatformVersionInfo;
  linux?: PlatformVersionInfo;
  ios?: PlatformVersionInfo;
};

export type UpdateAction =
  | { kind: 'none' }
  | { kind: 'refresh'; message: string; mandatory: boolean; remoteBuildId: string }
  | {
      kind: 'native';
      platform: 'android' | 'windows' | 'linux' | 'ios';
      message: string;
      notes: string;
      mandatory: boolean;
      version: string;
      installUrl: string;
      canAutoInstall: boolean;
    };

interface AppUpdatePlugin {
  getNativeVersion(): Promise<{ versionName?: string; versionCode?: number; packageName?: string }>;
  downloadAndInstall(options: { url: string }): Promise<{ ok?: boolean }>;
  openUrl(options: { url: string }): Promise<{ ok?: boolean }>;
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate');

export function packageVersion(): string {
  try {
    return String(import.meta.env.VITE_APP_VERSION || '1.3.7');
  } catch {
    return '1.3.7';
  }
}

export function localWebBuildId(): string {
  try {
    return String(import.meta.env.VITE_WEB_BUILD_ID || '');
  } catch {
    return '';
  }
}

function parseSemver(v: string): number[] {
  return String(v || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((p) => Number.parseInt(p, 10) || 0);
}

export function isNewerVersion(remote: string, local: string): boolean {
  const a = parseSemver(remote);
  const b = parseSemver(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function fetchVersionManifest(cacheBust = true): Promise<VersionManifest | null> {
  const url = cacheBust ? `${VERSION_JSON_URL}?t=${Date.now()}` : VERSION_JSON_URL;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as VersionManifest;
  } catch {
    return null;
  }
}

async function getAndroidNativeVersion(): Promise<{ versionName: string; versionCode: number }> {
  try {
    const v = await AppUpdate.getNativeVersion();
    return {
      versionName: v.versionName || packageVersion(),
      versionCode: Number(v.versionCode) || 0,
    };
  } catch {
    return { versionName: packageVersion(), versionCode: 0 };
  }
}

export async function evaluateUpdate(manifest?: VersionManifest | null): Promise<UpdateAction> {
  const remote = manifest ?? (await fetchVersionManifest());
  if (!remote) return { kind: 'none' };

  const mandatory = Boolean(remote.mandatory);
  const localBuild = localWebBuildId();
  const remoteBuild = remote.webBuildId || '';

  // Prefer native APK bumps over web refresh when the shell itself is behind.
  if (isAndroidApp()) {
    const local = await getAndroidNativeVersion();
    const a = remote.android || {};
    const remoteCode = Number(a.versionCode) || 0;
    const remoteName = a.versionName || a.version || '';
    const newer =
      (remoteCode > 0 && local.versionCode > 0 && remoteCode > local.versionCode) ||
      (remoteName && isNewerVersion(remoteName, local.versionName));
    const belowMin =
      a.minSupportedCode != null && local.versionCode > 0 && local.versionCode < a.minSupportedCode;
    if (newer || belowMin) {
      return {
        kind: 'native',
        platform: 'android',
        message: belowMin ? 'This app version is no longer supported. Please update.' : 'Update available',
        notes: a.notes || remote.notes || '',
        mandatory: mandatory || belowMin,
        version: remoteName || String(remoteCode),
        installUrl: a.apkUrl || 'https://scorr.walfia.ai/downloads/scorr.apk',
        canAutoInstall: true,
      };
    }
  }

  // Web / PWA / Capacitor WebView content refresh when deploy id advances
  if (remoteBuild && localBuild && remoteBuild !== localBuild) {
    return {
      kind: 'refresh',
      message: 'New version available — Refresh',
      mandatory,
      remoteBuildId: remoteBuild,
    };
  }

  if (isDesktopApp()) {
    const plat = navigator.userAgent.toLowerCase().includes('windows') ? 'windows' : 'linux';
    const info = (plat === 'windows' ? remote.windows : remote.linux) || {};
    const remoteVer = info.version || '';
    if (remoteVer && isNewerVersion(remoteVer, packageVersion())) {
      const installUrl =
        plat === 'windows'
          ? info.setupUrl || 'https://scorr.walfia.ai/downloads/Scorr-Setup.exe'
          : info.appImageUrl ||
            info.debUrl ||
            'https://scorr.walfia.ai/downloads/Scorr.deb';
      return {
        kind: 'native',
        platform: plat,
        message: 'Update available',
        notes: info.notes || remote.notes || '',
        mandatory,
        version: remoteVer,
        installUrl,
        canAutoInstall: plat === 'windows' || Boolean(info.appImageUrl),
      };
    }
  }

  if (isIosApp() || (Capacitor.getPlatform() === 'ios')) {
    const info = remote.ios || {};
    const remoteVer = info.version || '';
    if (remoteVer && isNewerVersion(remoteVer, packageVersion())) {
      return {
        kind: 'native',
        platform: 'ios',
        message: 'Update available',
        notes: info.notes || remote.notes || '',
        mandatory,
        version: remoteVer,
        installUrl: info.storeUrl || info.pwaUrl || 'https://scorr.walfia.ai/?app=1',
        canAutoInstall: false,
      };
    }
  }

  return { kind: 'none' };
}

export function shouldRunPeriodicCheck(intervalMs = 6 * 60 * 60 * 1000): boolean {
  try {
    const last = Number(localStorage.getItem(CHECK_KEY) || 0);
    return !Number.isFinite(last) || Date.now() - last >= intervalMs;
  } catch {
    return true;
  }
}

export function markUpdateChecked() {
  try {
    localStorage.setItem(CHECK_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function dismissUpdate(key: string) {
  try {
    sessionStorage.setItem(DISMISS_KEY, key);
  } catch {
    /* ignore */
  }
}

export function isUpdateDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === key;
  } catch {
    return false;
  }
}

export async function applyNativeUpdate(action: Extract<UpdateAction, { kind: 'native' }>): Promise<string> {
  if (action.platform === 'android' && action.canAutoInstall && isNativeApp()) {
    try {
      await AppUpdate.downloadAndInstall({ url: action.installUrl });
      return 'Downloading update… Android will prompt you to install. Login and attendance stay intact.';
    } catch (e) {
      window.open(action.installUrl, '_blank');
      return e instanceof Error ? e.message : 'Opened APK download.';
    }
  }

  if (action.platform === 'windows' || action.platform === 'linux') {
    const api = (window as unknown as { scorrDesktop?: { checkForUpdates?: () => Promise<{ ok?: boolean; message?: string }> } })
      .scorrDesktop;
    if (api?.checkForUpdates) {
      const res = await api.checkForUpdates();
      return res.message || 'Checking for desktop update…';
    }
    window.open(action.installUrl, '_blank');
    return 'Download started in your browser.';
  }

  window.open(action.installUrl, '_blank');
  return 'Open the App Store / TestFlight or refresh the Home Screen app.';
}

export function hardRefreshWeb() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set('_v', String(Date.now()));
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

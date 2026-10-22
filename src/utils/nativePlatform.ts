import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { registerAuthDeepLinkHandlers } from './authDeepLink';

type ScorrDesktopApi = {
  isDesktop: boolean;
  platform?: string;
  /** Set only in the Windows 11 desktop shell (OS build 22000+). */
  platformVariant?: 'windows11';
  windowsBuild?: number;
  getAppVersion?: () => Promise<string> | string;
  expandWorkspace?: () => void;
  shrinkToLogin?: () => void;
  saveAttendanceToken?: (token: string) => Promise<boolean> | void;
  clearAttendanceToken?: () => Promise<boolean> | void;
  hasAttendanceToken?: () => Promise<boolean> | boolean;
  saveLoginCredentials?: (email: string, password: string) => Promise<boolean> | boolean;
  loadLoginCredentials?: () => Promise<{ email: string; password: string } | null> | { email: string; password: string } | null;
  clearLoginCredentials?: () => Promise<boolean> | boolean;
  setAutoLaunch?: (enabled: boolean) => Promise<{ ok?: boolean; enabled?: boolean }> | { ok?: boolean; enabled?: boolean };
  getAutoLaunch?: () => Promise<{ enabled?: boolean }> | { enabled?: boolean };
  checkForUpdates?: () => Promise<{
    ok?: boolean;
    message?: string;
    updateAvailable?: boolean;
    autoInstall?: boolean;
    version?: string;
    packageKind?: string;
    downloadUrl?: string;
  }>;
  quitAndInstall?: () => Promise<{ ok?: boolean }> | { ok?: boolean };
  probeWifi?: () => Promise<{ ssid?: string | null; bssid?: string | null }>;
  notifyManualCheckIn?: () => Promise<{ ok?: boolean }> | { ok?: boolean };
  notifyManualCheckOut?: () => Promise<{ ok?: boolean }> | { ok?: boolean };
  wifiDiagnostics?: () => Promise<{
    platform?: string;
    windowsVersion?: string;
    locationAllowed?: boolean | null;
    locationMessage?: string | null;
    ssid?: string | null;
    bssid?: string | null;
    publicIp?: string | null;
    matchesSaved?: boolean;
    statusLine?: string;
    logPath?: string;
    autoLaunch?: boolean;
    trayRunning?: boolean;
    appRunning?: boolean;
    windowsBuild?: number | null;
    platformVariant?: string | null;
    lastResult?: { action?: string | null; reason?: string | null; message?: string | null; local_time?: string | null } | null;
  }>;
  openLocationSettings?: () => Promise<{ ok?: boolean }> | { ok?: boolean };
  prepareAutoAttendance?: () => Promise<{
    ok?: boolean;
    autoLaunch?: boolean;
    notifications?: string;
    location?: string;
    wifiOk?: boolean;
    wifi?: { ssid?: string | null; bssid?: string | null };
  }>;
  /** Desktop only — a manual Clock Out holds automatic check-in until the next shift. */
  notifyManualCheckout?: () => Promise<{ ok?: boolean }> | { ok?: boolean };
  onUpdateReady?: (cb: (payload: { version?: string; message?: string; autoInstall?: boolean }) => void) => () => void;
  onUpdateStatus?: (
    cb: (payload: {
      phase?: string;
      message?: string;
      version?: string;
      percent?: number;
      autoInstall?: boolean;
      packageKind?: string;
    }) => void,
  ) => () => void;
};

declare global {
  interface Window {
    scorrDesktop?: ScorrDesktopApi;
  }
}

/** UA-only hint — Electron sets this even when preload fails. Do NOT use alone for auto check-in. */
export function hasScorrDesktopUa(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return /\bScorrDesktop\//i.test(window.navigator.userAgent);
  } catch {
    return false;
  }
}

/** Chromium Electron runtime UA (always present in real scorr-desktop, even ancient builds). */
export function hasElectronRuntimeUa(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return /\bElectron\//i.test(window.navigator.userAgent);
  } catch {
    return false;
  }
}

/**
 * Main process injects these when the real Electron window loads the site.
 * Distinguishes Chrome tabs from Scorr Desktop even if preload/bridge failed.
 */
export function hasScorrElectronShellMarker(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const w = window as Window & {
      __SCORR_ELECTRON_SHELL__?: boolean;
      __SCORR_ELECTRON_VERSION__?: string;
    };
    if (w.__SCORR_ELECTRON_SHELL__ === true) return true;
    if (typeof w.__SCORR_ELECTRON_VERSION__ === 'string' && w.__SCORR_ELECTRON_VERSION__) return true;
    if (typeof document !== 'undefined' && document.documentElement?.dataset?.scorrDesktop) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Any Electron preload API (even old shells that only expose expandWorkspace). */
export function hasScorrDesktopApi(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.scorrDesktop?.isDesktop);
}

/**
 * True when main can save the attendance token (1.3.29+ shells).
 * Ancient 1.3.4 preload exposes isDesktop but NOT saveAttendanceToken — that is NOT armed.
 */
export function hasScorrDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.scorrDesktop?.isDesktop && window.scorrDesktop?.saveAttendanceToken);
}

/** Running inside scorr-desktop / Electron (may still need a binary update to arm check-in). */
export function isElectronShell(): boolean {
  return (
    hasScorrDesktopBridge() ||
    hasScorrDesktopApi() ||
    hasScorrElectronShellMarker() ||
    hasScorrDesktopUa() ||
    hasElectronRuntimeUa()
  );
}

/**
 * Chrome/Edge “Install app” / PWA window — looks like an app but is still a browser
 * (no Electron tray / auto check-in). Common on Linux when users skip the .deb.
 */
export function isBrowserInstalledShell(): boolean {
  if (typeof window === 'undefined') return false;
  if (hasScorrDesktopBridge() || isNativeApp()) return false;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    /* ignore */
  }
  return Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
}

/**
 * True inside the Electron / scorr-desktop window.
 * Arming auto check-in still requires hasScorrDesktopBridge() (saveAttendanceToken).
 */
export function isDesktopApp(): boolean {
  return isElectronShell();
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/** True when running as installed app (APK, Electron, or home-screen PWA) — not the marketing website. */
export function isAppShell(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (isDesktopApp()) return true;
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone) return true;
  // Deep link / install URL used for iOS home-screen installs and desktop shell
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('app') === '1' || q.get('mode') === 'app') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Grow the Electron window after sign-in; no-op on web/mobile. */
export function notifyDesktopWorkspace(): void {
  try {
    window.scorrDesktop?.expandWorkspace?.();
  } catch {
    /* ignore */
  }
}

/** Shrink the Electron window back to the Sign In card size. */
export function notifyDesktopLogin(): void {
  try {
    window.scorrDesktop?.shrinkToLogin?.();
  } catch {
    /* ignore */
  }
}

export function isAndroidApp(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export function isIosApp(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

/** True on iPhone/iPad browsers and Home Screen PWAs (not only Capacitor). */
export function isIosUa(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  // iPadOS 13+ desktop UA
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

/**
 * iPhone/iPad website saved with Add to Home Screen (standalone), not Safari tabs
 * and not the Capacitor shell.
 */
export function isIosHomeScreen(): boolean {
  if (!isIosUa() || isNativeApp()) return false;
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    /* ignore */
  }
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Capacitor iOS app or the iOS Home Screen app. */
export function isIosPhoneClient(): boolean {
  return isIosApp() || isIosHomeScreen();
}

/** Platform stored on the attendance device row. Home Screen iPhone counts as ios. */
export function clientAttendancePlatform(): 'android' | 'ios' | 'windows' | 'linux' | 'web' {
  if (Capacitor.getPlatform() === 'android') return 'android';
  if (Capacitor.getPlatform() === 'ios' || isIosHomeScreen()) return 'ios';
  if (isDesktopApp()) {
    const plat = window.scorrDesktop?.platform;
    if (plat === 'win32') return 'windows';
    if (plat === 'linux') return 'linux';
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('windows') ? 'windows' : 'linux';
  }
  return 'web';
}

/** Initialize native shell (status bar, back button). Safe to call on web. */
export async function initNativeApp(): Promise<void> {
  if (isAppShell()) {
    document.documentElement.classList.add('app-shell');
    document.body.classList.add('app-shell');
    document.getElementById('root')?.classList.add('native-app-root');
  }

  // iOS (Capacitor or Safari / Home Screen) — used for safe-area CSS fallbacks.
  if (isIosApp() || isIosUa()) {
    document.documentElement.classList.add('ios-device');
    document.body.classList.add('ios-device');
  }

  if (!isNativeApp()) return;

  document.documentElement.classList.add('native-app');
  document.body.classList.add('native-app');

  try {
  if (isAndroidApp()) {
    await StatusBar.setBackgroundColor({ color: '#0b1120' });
    await StatusBar.setOverlaysWebView({ overlay: false });
  }
  if (isIosApp()) {
    // Style.Light = light icons/text for dark app chrome.
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setBackgroundColor({ color: '#0b1120' });
  }
  } catch {
    // Status bar plugin may be unavailable in some WebView builds.
  }

  if (isAndroidApp()) {
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
        return;
      }
      // Stay signed in — return to the previous in-app page when possible,
      // otherwise minimize instead of dumping the user on the homepage.
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      void App.minimizeApp();
    });
  }

  // Supabase recovery / magic-link / MFA emails → ai.walfia.scorr://…
  void registerAuthDeepLinkHandlers();

  window.addEventListener('load', () => {
    void SplashScreen.hide();
  });
}

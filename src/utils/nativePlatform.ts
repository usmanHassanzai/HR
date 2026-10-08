import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { registerAuthDeepLinkHandlers } from './authDeepLink';

type ScorrDesktopApi = {
  isDesktop: boolean;
  platform?: string;
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
  checkForUpdates?: () => Promise<{ ok?: boolean; message?: string }>;
  quitAndInstall?: () => Promise<{ ok?: boolean }> | { ok?: boolean };
  onUpdateReady?: (cb: (payload: { version?: string; message?: string; autoInstall?: boolean }) => void) => () => void;
};

declare global {
  interface Window {
    scorrDesktop?: ScorrDesktopApi;
  }
}

/** True inside the Electron desktop installer (ScorrDesktop UA / preload bridge). */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.scorrDesktop?.isDesktop) return true;
  try {
    return /\bScorrDesktop\//i.test(window.navigator.userAgent);
  } catch {
    return false;
  }
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

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

/** Initialize native shell (status bar, back button). Safe to call on web. */
export async function initNativeApp(): Promise<void> {
  if (isAppShell()) {
    document.documentElement.classList.add('app-shell');
    document.body.classList.add('app-shell');
    document.getElementById('root')?.classList.add('native-app-root');
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
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setOverlaysWebView({ overlay: false });
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

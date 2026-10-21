import { Capacitor } from '@capacitor/core';

function isScorrDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as Window & { scorrDesktop?: { isDesktop?: boolean } }).scorrDesktop?.isDesktop) {
    return true;
  }
  try {
    return /\bScorrDesktop\//i.test(window.navigator.userAgent);
  } catch {
    return false;
  }
}

/** Google Play listing (live only after the app is published). Currently 404 — do not use as primary CTA. */
export const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=ai.walfia.scorr';

/**
 * Set true only after the Play listing is public.
 * Until then Android CTAs download the APK directly.
 */
export const PLAY_STORE_LIVE = false;

/**
 * Apple App Store product page.
 * Set `VITE_APP_STORE_URL` (e.g. https://apps.apple.com/app/scorr/idXXXXXXXXX)
 * when the listing is live.
 */
export const APP_STORE_URL = (
  (import.meta.env.VITE_APP_STORE_URL as string | undefined) || ''
).trim();

/** Direct IPA (Ad Hoc / enterprise) — same pattern as Android APK when published. */
export const IPA_PATH = '/downloads/scorr.ipa';

/** OTA install manifest for Ad Hoc IPA (itms-services). */
export const IOS_MANIFEST_PATH = '/downloads/ios/manifest.plist';

export const IOS_PWA_INSTALL_URL = 'https://scorr.walfia.ai/?app=1';

/** Direct APK download remains public until this date (30 days from 2026-10-02). */
export const APK_DIRECT_UNTIL = new Date('2026-11-01T00:00:00.000Z');

export const APK_PATH = '/downloads/scorr.apk';

/**
 * Desktop packages are large and hosted on GitHub Releases (not Vercel —
 * *.deb / *.exe are gitignored so /downloads/Scorr.deb 404s on the site).
 * Windows and Linux can point at different release tags (Windows-only hotfixes).
 */
declare const __SCORR_WINDOWS_DESKTOP_RELEASE__: string;

/** Injected from scripts/write-version-json.mjs WINDOWS_RELEASE. Linux stays 1.3.45. */
const WINDOWS_DESKTOP_RELEASE = __SCORR_WINDOWS_DESKTOP_RELEASE__;
const DESKTOP_GH_WIN =
  `https://github.com/usmanHassanzai/HR/releases/download/desktop-v${WINDOWS_DESKTOP_RELEASE}`;
const DESKTOP_GH_LINUX =
  'https://github.com/usmanHassanzai/HR/releases/download/desktop-v1.3.45';

// Do not read VITE_DESKTOP_* from .env. Those values are stale (desktop-v1.3.8).
export const DESKTOP_WIN_PATH = `${DESKTOP_GH_WIN}/Scorr-Setup.exe`;

/** Linux .deb package (Electron). */
export const DESKTOP_LINUX_DEB_PATH = `${DESKTOP_GH_LINUX}/Scorr.deb`;

export const DESKTOP_LINUX_APPIMAGE_PATH = `${DESKTOP_GH_LINUX}/Scorr.AppImage`;

export function isApkDirectDownloadAvailable(now = new Date()): boolean {
  return now.getTime() < APK_DIRECT_UNTIL.getTime();
}

/** Prefer Windows Setup / Linux deb based on UA. */
export function desktopPrimaryInstallHref(): string {
  if (typeof navigator === 'undefined') return DESKTOP_WIN_PATH;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('linux') && !ua.includes('android')) return DESKTOP_LINUX_DEB_PATH;
  return DESKTOP_WIN_PATH;
}

/** Working Android install target — APK until Play is live. */
export function androidInstallHref(): string {
  if (PLAY_STORE_LIVE) return PLAY_STORE_URL;
  return APK_PATH;
}

export function androidInstallIsDownload(): boolean {
  return !PLAY_STORE_LIVE && isApkDirectDownloadAvailable();
}

/** Working iOS install target — App Store → IPA OTA → PWA fallback. */
export function iosInstallHref(opts?: { ipaAvailable?: boolean }): string {
  if (APP_STORE_URL) return APP_STORE_URL;
  if (opts?.ipaAvailable) return IPA_PATH;
  return IOS_PWA_INSTALL_URL;
}

export function iosInstallIsAppStore(): boolean {
  return Boolean(APP_STORE_URL);
}

export function iosInstallIsIpa(opts?: { ipaAvailable?: boolean }): boolean {
  return !APP_STORE_URL && Boolean(opts?.ipaAvailable);
}

/** Safari OTA install URL for Ad Hoc / enterprise IPA (requires HTTPS manifest). */
export function iosOtaInstallHref(origin = 'https://scorr.walfia.ai'): string {
  const manifestUrl = `${origin.replace(/\/$/, '')}${IOS_MANIFEST_PATH}`;
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

/** Store / sideload install CTAs — never show inside Capacitor or Electron shells. */
export function showStoreInstallCtas(): boolean {
  return !Capacitor.isNativePlatform() && !isScorrDesktopShell();
}

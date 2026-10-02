import { Capacitor } from '@capacitor/core';

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
 * when the listing is live; until then iOS uses Home Screen install.
 */
export const APP_STORE_URL = (
  (import.meta.env.VITE_APP_STORE_URL as string | undefined) || ''
).trim();

export const IOS_PWA_INSTALL_URL = 'https://scorr.walfia.ai/?app=1';

/** Direct APK download remains public until this date (30 days from 2026-10-02). */
export const APK_DIRECT_UNTIL = new Date('2026-11-01T00:00:00.000Z');

export const APK_PATH = '/downloads/scorr.apk';

export function isApkDirectDownloadAvailable(now = new Date()): boolean {
  return now.getTime() < APK_DIRECT_UNTIL.getTime();
}

/** Working Android install target — APK until Play is live. */
export function androidInstallHref(): string {
  if (PLAY_STORE_LIVE) return PLAY_STORE_URL;
  return APK_PATH;
}

export function androidInstallIsDownload(): boolean {
  return !PLAY_STORE_LIVE && isApkDirectDownloadAvailable();
}

/** Working iOS install target — App Store when configured, else PWA install page. */
export function iosInstallHref(): string {
  return APP_STORE_URL || IOS_PWA_INSTALL_URL;
}

export function iosInstallIsAppStore(): boolean {
  return Boolean(APP_STORE_URL);
}

/** Store / sideload install CTAs — never show inside the Capacitor shell. */
export function showStoreInstallCtas(): boolean {
  return !Capacitor.isNativePlatform();
}

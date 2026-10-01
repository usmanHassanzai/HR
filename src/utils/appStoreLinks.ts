import { Capacitor } from '@capacitor/core';

/** Google Play listing for Scorr. */
export const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=ai.walfia.scorr';

/**
 * Apple App Store product page.
 * Set `VITE_APP_STORE_URL` in env (e.g. https://apps.apple.com/app/scorr/idXXXXXXXXX)
 * or replace the fallback once the listing URL is known.
 */
export const APP_STORE_URL = (
  (import.meta.env.VITE_APP_STORE_URL as string | undefined) || ''
).trim();

/** Direct APK download remains public until this date (30 days from 2026-10-02). */
export const APK_DIRECT_UNTIL = new Date('2026-11-01T00:00:00.000Z');

export const APK_PATH = '/downloads/scorr.apk';

export function isApkDirectDownloadAvailable(now = new Date()): boolean {
  return now.getTime() < APK_DIRECT_UNTIL.getTime();
}

/** Store / sideload install CTAs — never show inside the Capacitor shell. */
export function showStoreInstallCtas(): boolean {
  return !Capacitor.isNativePlatform();
}

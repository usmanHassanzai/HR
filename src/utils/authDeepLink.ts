import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { confirmRecoveryEmailToken, completeEmailMfaRecovery } from './mfaRecovery';

/** Custom URL scheme registered on Android + iOS for Capacitor deep links. */
export const NATIVE_URL_SCHEME = 'ai.walfia.scorr';

/** Supabase auth email redirect target inside the native app. */
export const NATIVE_AUTH_CALLBACK_URL = `${NATIVE_URL_SCHEME}://auth/callback`;

const PUBLIC_WEB_ORIGIN = 'https://scorr.walfia.ai';

/** Redirect URL for Supabase signup / recovery / magic-link emails. */
export function getAuthEmailRedirectTo(): string {
  if (Capacitor.isNativePlatform()) return NATIVE_AUTH_CALLBACK_URL;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return PUBLIC_WEB_ORIGIN;
}

function collectParams(url: URL): URLSearchParams {
  const merged = new URLSearchParams(url.search);
  if (url.hash && url.hash.length > 1) {
    const hash = url.hash.slice(1);
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
    new URLSearchParams(hashQuery).forEach((value, key) => {
      if (!merged.has(key)) merged.set(key, value);
    });
  }
  return merged;
}

function isOurDeepLink(url: URL): boolean {
  return url.protocol === `${NATIVE_URL_SCHEME}:`;
}

/**
 * Complete a Supabase session or MFA recovery action from a deep-link URL.
 * Safe to call with any URL; returns quickly when unrelated.
 */
export async function handleAuthDeepLink(rawUrl: string): Promise<'session' | 'mfa' | 'ignored'> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'ignored';
  }
  if (!isOurDeepLink(url)) return 'ignored';

  const params = collectParams(url);
  const code = params.get('code');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const mfaAction = params.get('mfa_action');
  const mfaToken = params.get('token');

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return 'session';
  }

  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return 'session';
  }

  if (mfaAction && mfaToken) {
    if (mfaAction === 'confirm_email') {
      await confirmRecoveryEmailToken(mfaToken);
    } else if (mfaAction === 'reset_2fa') {
      await completeEmailMfaRecovery(mfaToken);
    }
    return 'mfa';
  }

  return 'ignored';
}

/** Register cold-start + runtime deep-link listeners (native only). */
export async function registerAuthDeepLinkHandlers(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const run = (url: string) => {
    void handleAuthDeepLink(url).catch((err) => {
      console.warn('[authDeepLink]', err instanceof Error ? err.message : err);
    });
  };

  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) run(launch.url);
  } catch {
    /* no launch URL */
  }

  await App.addListener('appUrlOpen', ({ url }) => {
    if (url) run(url);
  });
}

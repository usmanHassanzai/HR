import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import LandingPage from './components/LandingPage';
import NativeScrollRoot from './components/NativeScrollRoot';
import SilentGeoAttendance from './components/SilentGeoAttendance';
import AppUpdateBanner from './components/AppUpdateBanner';
import { isAppShell } from './utils/nativePlatform';
import { isDeleteAccountRoute, isPlatformRoute } from './utils/companyHelpers';
import { isGeoHold, clearGeoHold } from './utils/attendanceBackgroundSession';
import { clearAppHashToRoot, isAppHash, leaveLoginHash } from './utils/appHashRoute';

const PortalApp = lazy(() => import('./PortalApp'));
const PlatformOwnerPortal = lazy(() => import('./components/PlatformOwnerPortal'));
const DeleteAccountPage = lazy(() => import('./components/DeleteAccountPage'));

function RouteFallback() {
  return <div style={{ minHeight: '100vh' }} aria-hidden />;
}

/** Peek localStorage only — does not import @supabase/supabase-js. */
function hasCachedSupabaseSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
        user?: { id?: string };
        currentSession?: { access_token?: string; refresh_token?: string };
      };
      if (
        parsed?.access_token
        || parsed?.refresh_token
        || parsed?.user?.id
        || parsed?.currentSession?.access_token
        || parsed?.currentSession?.refresh_token
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function shouldBootIntoPortal(): boolean {
  return hasCachedSupabaseSession() || isAppHash();
}

function hasMfaRecoveryParams(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('mfa_action') && params.get('token'));
  } catch {
    return false;
  }
}

/**
 * Marketing `/` paints immediately with no Supabase SDK and no session check.
 * After first paint we dynamically import the client; logged-in users enter PortalApp.
 * Sign In / Register (Login chunk) also pulls Supabase when the user opens auth.
 */
type MarketingBoot = 'portal' | 'marketing' | 'restoring';

function WebMarketingRoot() {
  const [portalSession, setPortalSession] = useState<unknown | null>(null);
  const [boot, setBoot] = useState<MarketingBoot>(() =>
    shouldBootIntoPortal() ? 'restoring' : 'marketing',
  );

  const enterPortal = useCallback((session: unknown) => {
    clearGeoHold();
    // Drop sticky #login from the Sign In deep-link so refresh does not reopen auth UI.
    leaveLoginHash();
    setPortalSession(session);
    setBoot('portal');
    try {
      const st = window.history.state && typeof window.history.state === 'object'
        ? { ...(window.history.state as Record<string, unknown>) }
        : {};
      window.history.replaceState({ ...st, scorrApp: 'dashboard' }, '', window.location.href);
    } catch {
      /* ignore */
    }
  }, []);

  const exitPortal = useCallback(() => {
    setPortalSession(null);
    setBoot('marketing');
    try {
      if (isAppHash() || window.location.hash === '#login') {
        clearAppHashToRoot();
      }
      const st = window.history.state && typeof window.history.state === 'object'
        ? { ...(window.history.state as Record<string, unknown>) }
        : {};
      if ('scorrApp' in st) {
        delete st.scorrApp;
        window.history.replaceState(st, '', window.location.href);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const afterFirstPaint = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

    void (async () => {
      // When a session (or #app route) is likely, skip the marketing paint delay so
      // refresh does not flash LandingPage / #login before PortalApp mounts.
      const restoring = shouldBootIntoPortal();
      if (!restoring) await afterFirstPaint();
      if (cancelled) return;

      const needsClient = restoring || hasMfaRecoveryParams();
      // Logged-out visitors: skip Supabase entirely until Sign In / Register mounts Login.
      if (!needsClient) {
        if (restoring) setBoot('marketing');
        return;
      }

      const { supabase, isSupabaseConfigured } = await import('./lib/supabase');
      if (!isSupabaseConfigured || cancelled) {
        if (!cancelled) setBoot('marketing');
        return;
      }

      if (hasMfaRecoveryParams()) {
        const params = new URLSearchParams(window.location.search);
        const action = params.get('mfa_action');
        const token = params.get('token');
        if (action && token) {
          try {
            const { confirmRecoveryEmailToken, completeEmailMfaRecovery } = await import('./utils/mfaRecovery');
            if (action === 'confirm_email') await confirmRecoveryEmailToken(token);
            else if (action === 'reset_2fa') await completeEmailMfaRecovery(token);
          } catch {
            /* ignore — user can retry from account security */
          } finally {
            params.delete('mfa_action');
            params.delete('token');
            const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
            window.history.replaceState({}, '', next);
          }
        }
      }
      if (cancelled) return;

      const {
        isPortalSessionExpired,
        lockPortalSession,
        markPortalSessionStart,
      } = await import('./utils/usePortalSessionGuard');

      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.user && isPortalSessionExpired()) {
        await lockPortalSession({ force: true, reason: 'session_expired' });
        if (!cancelled) {
          clearAppHashToRoot();
          setBoot('marketing');
        }
      } else if (session?.user && !isGeoHold()) {
        // Geo-hold logout: keep session for background GPS, stay on landing page.
        markPortalSessionStart(false);
        enterPortal(session);
      } else if (!cancelled) {
        // Stale #app hash / empty cache peek — fall through to marketing.
        if (isAppHash()) clearAppHashToRoot();
        setBoot('marketing');
      }

      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
        if (event === 'SIGNED_IN' && nextSession?.user) {
          markPortalSessionStart(true);
          enterPortal(nextSession);
        } else if (event === 'SIGNED_OUT') {
          exitPortal();
        } else if (event === 'TOKEN_REFRESHED' && isPortalSessionExpired()) {
          void lockPortalSession({ force: true, reason: 'session_expired' });
        }
      });
      unsubscribe = () => subscription.unsubscribe();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // boot only used for one-shot restoring→marketing fallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterPortal, exitPortal]);

  if (boot === 'portal') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PortalApp
          initialSession={portalSession as { user?: { id: string } } | null}
          onSignedOut={exitPortal}
        />
      </Suspense>
    );
  }

  if (boot === 'restoring') {
    return <RouteFallback />;
  }

  return (
    <>
      <SilentGeoAttendance />
      <LandingPage onLoginSuccess={enterPortal} />
    </>
  );
}

function App() {
  let content: ReactNode;

  if (isPlatformRoute()) {
    content = (
      <NativeScrollRoot>
        <Suspense fallback={<RouteFallback />}>
          <PlatformOwnerPortal />
        </Suspense>
      </NativeScrollRoot>
    );
  } else if (isDeleteAccountRoute()) {
    content = (
      <NativeScrollRoot>
        <Suspense fallback={<RouteFallback />}>
          <DeleteAccountPage />
        </Suspense>
      </NativeScrollRoot>
    );
  } else if (isAppShell()) {
    // Installed app / PWA shell — auth required; load portal (and Supabase) immediately.
    content = (
      <Suspense fallback={<RouteFallback />}>
        <PortalApp />
      </Suspense>
    );
  } else {
    content = <WebMarketingRoot />;
  }

  return (
    <>
      <AppUpdateBanner />
      {content}
      <SpeedInsights />
    </>
  );
}

export default App;

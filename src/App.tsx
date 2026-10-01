import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import LandingPage from './components/LandingPage';
import NativeScrollRoot from './components/NativeScrollRoot';
import { isAppShell } from './utils/nativePlatform';
import { isDeleteAccountRoute, isPlatformRoute } from './utils/companyHelpers';

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
        currentSession?: { access_token?: string };
      };
      if (parsed?.access_token || parsed?.currentSession?.access_token) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
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
function WebMarketingRoot() {
  const [portalSession, setPortalSession] = useState<unknown | null>(null);
  const [showPortal, setShowPortal] = useState(false);

  const enterPortal = useCallback((session: unknown) => {
    setPortalSession(session);
    setShowPortal(true);
    try {
      const st = window.history.state && typeof window.history.state === 'object'
        ? { ...(window.history.state as Record<string, unknown>) }
        : {};
      window.history.replaceState({ ...st, scorrApp: 'dashboard' }, '');
    } catch {
      /* ignore */
    }
  }, []);

  const exitPortal = useCallback(() => {
    setPortalSession(null);
    setShowPortal(false);
    try {
      if (window.location.hash === '#login') {
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
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
      await afterFirstPaint();
      if (cancelled) return;

      const needsClient = hasCachedSupabaseSession() || hasMfaRecoveryParams();
      // Logged-out visitors: skip Supabase entirely until Sign In / Register mounts Login.
      if (!needsClient) return;

      const { supabase, isSupabaseConfigured } = await import('./lib/supabase');
      if (!isSupabaseConfigured || cancelled) return;

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

      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.user) {
        enterPortal(session);
      }

      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
        if (event === 'SIGNED_IN' && nextSession?.user) {
          enterPortal(nextSession);
        } else if (event === 'SIGNED_OUT') {
          exitPortal();
        }
      });
      unsubscribe = () => subscription.unsubscribe();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enterPortal, exitPortal]);

  if (showPortal) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PortalApp
          initialSession={portalSession as { user?: { id: string } } | null}
          onSignedOut={exitPortal}
        />
      </Suspense>
    );
  }

  return <LandingPage onLoginSuccess={enterPortal} />;
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
      {content}
      <SpeedInsights />
    </>
  );
}

export default App;

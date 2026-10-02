import { useState, useEffect, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { Profile } from './utils/kpiHelpers';
import NativeScrollRoot from './components/NativeScrollRoot';
import DemoModeBanner from './components/DemoModeBanner';
import { isAppShell, isNativeApp } from './utils/nativePlatform';
import { SplashScreen } from '@capacitor/splash-screen';
import { applyBranding, fetchCompanyBranding, loadBranding } from './lib/branding';
import { isDemoProfile } from './utils/demoMode';
import { fetchMyCompany, Company, isPlatformOwner } from './utils/companyHelpers';
import { useSupabaseRealtime } from './utils/useSupabaseRealtime';
import { usePortalSessionGuard } from './utils/usePortalSessionGuard';
import {
  clearGeoHold,
  isGeoHold,
  setAttendanceLogoutProfile,
  subscribeGeoHold,
} from './utils/attendanceBackgroundSession';
import { GEO_DASHBOARD_OPEN_EVENT } from './utils/geoAttendance';
import { startPresenceHeartbeat } from './utils/presenceHeartbeat';
import { roleRequiresMfa, currentMfaLevel, getVerifiedTotpFactorId } from './utils/mfaHelpers';
import { confirmRecoveryEmailToken, completeEmailMfaRecovery, hasMfaSessionGrant } from './utils/mfaRecovery';
import { Loader2, AlertCircle } from 'lucide-react';

const AppLoginScreen = lazy(() => import('./components/AppLoginScreen'));
const EmployeeDashboard = lazy(() => import('./components/EmployeeDashboard'));
const ManagerDashboard = lazy(() => import('./components/ManagerDashboard'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const Header = lazy(() => import('./components/Header'));
const GeoAttendanceTracker = lazy(() => import('./components/GeoAttendanceTracker'));
const PrivilegedMfaGate = lazy(() => import('./components/PrivilegedMfaGate'));
const CompanyPendingScreen = lazy(() => import('./components/CompanyPendingScreen'));

/** Empty viewport placeholder — avoids spinner CLS on route transitions. */
function RouteFallback() {
  return <div style={{ minHeight: '100vh' }} aria-hidden />;
}

export type PortalAppProps = {
  /** Session already resolved by the marketing shell (after first paint). */
  initialSession?: { user?: { id: string } } | null;
  /** When the portal signs out (web marketing), return to `/` without a session check gate. */
  onSignedOut?: () => void;
};

function PortalApp({ initialSession = null, onSignedOut }: PortalAppProps) {
  const [session, setSession] = useState<any>(initialSession);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoExpired, setDemoExpired] = useState(false);
  const [geoHold, setGeoHold] = useState(() => isGeoHold());
  const [privilegedMfaOk, setPrivilegedMfaOk] = useState(false);
  const [mfaLinkMsg, setMfaLinkMsg] = useState('');
  usePortalSessionGuard(Boolean(session), { idle: Boolean(session) && !geoHold });

  useEffect(() => {
    if (!session?.user?.id) {
      setPrivilegedMfaOk(false);
      return;
    }
    try {
      if (sessionStorage.getItem('scorr-mfa-ok') === session.user.id) {
        setPrivilegedMfaOk(true);
      }
    } catch {
      /* ignore */
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id || !privilegedMfaOk) return;
    try {
      sessionStorage.setItem('scorr-mfa-ok', session.user.id);
    } catch {
      /* ignore */
    }
  }, [session?.user?.id, privilegedMfaOk]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('mfa_action');
    const token = params.get('token');
    if (!action || !token) return;
    let cancelled = false;
    void (async () => {
      try {
        if (action === 'confirm_email') {
          await confirmRecoveryEmailToken(token);
          if (!cancelled) setMfaLinkMsg('Recovery email confirmed. You can use email recovery if you lose your authenticator.');
        } else if (action === 'reset_2fa') {
          const msg = await completeEmailMfaRecovery(token);
          if (!cancelled) setMfaLinkMsg(msg);
        }
      } catch (e) {
        if (!cancelled) setMfaLinkMsg(e instanceof Error ? e.message : 'Recovery link failed.');
      } finally {
        params.delete('mfa_action');
        params.delete('token');
        const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', next);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setAttendanceLogoutProfile(profile);
  }, [profile]);

  useEffect(() => subscribeGeoHold(() => setGeoHold(isGeoHold())), []);

  useEffect(() => {
    if (!session?.user?.id || !profile || !roleRequiresMfa(profile)) return;
    let cancelled = false;
    void (async () => {
      const [grant, verifiedId, level] = await Promise.all([
        hasMfaSessionGrant().catch(() => false),
        getVerifiedTotpFactorId().catch(() => null),
        currentMfaLevel().catch(() => null),
      ]);
      if (cancelled) return;
      if (level === 'aal2' && verifiedId) {
        setPrivilegedMfaOk(true);
        return;
      }
      if (grant && verifiedId) {
        setPrivilegedMfaOk(true);
        return;
      }
      setPrivilegedMfaOk(false);
    })();
    return () => { cancelled = true; };
  }, [session?.user?.id, profile?.id, profile?.role]);

  useEffect(() => {
    if (!session || !profile || geoHold) return;
    if (profile.role !== 'employee' && profile.role !== 'manager' && profile.role !== 'hr') return;
    window.dispatchEvent(new Event(GEO_DASHBOARD_OPEN_EVENT));
  }, [session, profile, geoHold]);

  useEffect(() => {
    if (!session || !profile || geoHold) return;
    if (profile.role !== 'employee' && profile.role !== 'manager' && profile.role !== 'hr') return;
    return startPresenceHeartbeat();
  }, [session, profile, geoHold]);

  const fetchUserProfile = async (userId: string) => {
    try {
      const { data, error: profileError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

      if (profileError) {
        if (profileError.code === 'PGRST116' || profileError.message.includes('does not exist')) {
          setError('Supabase connection works, but schema tables are not initialized. Please run schema.sql first.');
        } else {
          setError(profileError.message);
        }
        setProfile(null);
        setCompany(null);
        return;
      }

      const { data: sessionInfo } = await supabase.rpc('get_my_session_info');
      const sessionRow = Array.isArray(sessionInfo) ? sessionInfo[0] : sessionInfo;
      const mergedProfile = sessionRow?.is_platform_owner
        ? { ...data, is_platform_owner: true as const }
        : data;

      setProfile(mergedProfile);
      setError('');

      const remoteBranding = await fetchCompanyBranding(isDemoProfile(data));
      applyBranding(remoteBranding ?? loadBranding(isDemoProfile(data)));

      const { data: expired } = await supabase.rpc('is_demo_expired');
      setDemoExpired(expired === true);

      if (data.company_id && !isDemoProfile(data)) {
        try {
          const co = await fetchMyCompany(supabase);
          setCompany(co);
        } catch {
          setCompany(null);
        }
      } else {
        setCompany(null);
      }
    } catch (err: any) {
      setError(err.message || 'Error loading profile data.');
      setProfile(null);
      setCompany(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const activeSession = initialSession ?? (await supabase.auth.getSession()).data.session;
      if (cancelled) return;
      setSession(activeSession);
      if (activeSession?.user) {
        await fetchUserProfile(activeSession.user.id);
      }
      if (!cancelled) setLoading(false);
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, activeSession) => {
      setSession(activeSession);
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        return;
      }
      if (activeSession?.user) {
        if (event === 'SIGNED_IN') {
          clearGeoHold();
          setGeoHold(false);
          try {
            setPrivilegedMfaOk(sessionStorage.getItem('scorr-mfa-ok') === activeSession.user.id);
          } catch {
            setPrivilegedMfaOk(false);
          }
          void fetchUserProfile(activeSession.user.id);
        } else if (event === 'USER_UPDATED') {
          void fetchUserProfile(activeSession.user.id);
        }
      } else {
        setProfile(null);
        setCompany(null);
        setPrivilegedMfaOk(false);
        setLoading(false);
        try {
          sessionStorage.removeItem('scorr-mfa-ok');
        } catch {
          /* ignore */
        }
        if (!isGeoHold()) {
          onSignedOut?.();
        }
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
    // initialSession only used for first paint handoff from marketing shell
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading && isNativeApp()) {
      void SplashScreen.hide();
    }
  }, [loading]);

  const refreshCompanyStatus = useCallback(async () => {
    if (!session?.user?.id || !profile?.company_id || isDemoProfile(profile)) return;
    try {
      const co = await fetchMyCompany(supabase);
      setCompany(co);
      if (co?.status === 'active') {
        await fetchUserProfile(session.user.id);
      }
    } catch {
      /* ignore */
    }
  }, [session?.user?.id, profile?.company_id, profile]);

  useSupabaseRealtime(
    `company-status-${profile?.company_id ?? 'none'}`,
    profile?.company_id
      ? [{ table: 'companies', filter: `id=eq.${profile.company_id}` }]
      : [],
    refreshCompanyStatus,
    !!profile?.company_id && company?.status !== 'active',
  );

  const handleLoginSuccess = async (activeSession: any) => {
    clearGeoHold();
    setGeoHold(false);
    setSession(activeSession);
    setLoading(true);
    setError('');
    try {
      const st = window.history.state && typeof window.history.state === 'object'
        ? { ...(window.history.state as Record<string, unknown>) }
        : {};
      window.history.replaceState({ ...st, scorrApp: 'dashboard' }, '');
    } catch {
      /* ignore */
    }
    if (activeSession?.user?.id) {
      await fetchUserProfile(activeSession.user.id);
    }
    setLoading(false);
  };

  const handleLogout = () => {
    if (isGeoHold()) {
      setGeoHold(true);
      return;
    }
    void supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setCompany(null);
    setPrivilegedMfaOk(false);
    try {
      sessionStorage.removeItem('scorr-mfa-ok');
    } catch {
      /* ignore */
    }
    applyBranding(loadBranding(false));
    onSignedOut?.();
  };

  if (!isSupabaseConfigured) {
    const configView = (
      <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '560px', padding: '2.5rem', textAlign: 'center', borderLeft: '4px solid var(--color-warning)' }}>
          <AlertCircle size={40} style={{ color: 'var(--color-warning)', marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.5rem', fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>Supabase Not Configured</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: '0.95rem' }}>
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Vercel → Settings → Environment Variables, then redeploy.
          </p>
        </div>
      </div>
    );
    return <NativeScrollRoot>{configView}</NativeScrollRoot>;
  }

  if (loading && !profile) {
    const loadingView = (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', gap: '1rem' }}>
        <Loader2 size={36} className="animate-spin" style={{ color: 'var(--accent-primary)', animation: 'spin 1.5s linear infinite' }} />
        <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {isAppShell() ? 'Loading Scorr…' : 'Initializing HR Portal...'}
        </span>
      </div>
    );
    return <NativeScrollRoot>{loadingView}</NativeScrollRoot>;
  }

  if (session && error) {
    const errorView = (
      <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '560px', padding: '2.5rem', textAlign: 'center', borderLeft: '4px solid var(--color-danger)' }}>
          <AlertCircle size={40} style={{ color: 'var(--color-danger)', marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.5rem', fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>Database Configuration Needed</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>{error}</p>
          <button className="btn btn-primary" style={{ marginTop: '1.5rem' }} onClick={() => window.location.reload()}>Retry Connection</button>
          <button className="btn btn-secondary" style={{ marginTop: '1.5rem', marginLeft: '0.5rem' }} onClick={() => { void supabase.auth.signOut(); handleLogout(); }}>Sign Out</button>
        </div>
      </div>
    );
    return <NativeScrollRoot>{errorView}</NativeScrollRoot>;
  }

  // App shell (APK / PWA) keeps an in-chunk login screen. Web marketing exits to `/`.
  const loginScreen = isAppShell() ? (
    <NativeScrollRoot>
      <Suspense fallback={<RouteFallback />}>
        <AppLoginScreen onLoginSuccess={handleLoginSuccess} />
      </Suspense>
    </NativeScrollRoot>
  ) : (
    <RouteFallback />
  );

  const staffSession = session && profile && (profile.role === 'employee' || profile.role === 'manager' || profile.role === 'hr');
  const geoTracker = staffSession ? (
    <Suspense fallback={null}>
      <GeoAttendanceTracker profile={profile} />
    </Suspense>
  ) : null;

  let main: ReactNode;
  if (geoHold && session && profile) {
    main = (
      <>
        <div className="geo-hold-banner" role="status">
          <p>
            You left the dashboard, but location is still checked every 5 minutes until your shift ends.
            Keep this page open. Sign in again whenever you want to return.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void handleLoginSuccess(session)}>
            Back to dashboard
          </button>
        </div>
        {loginScreen}
      </>
    );
  } else if (!session || !profile) {
    if (onSignedOut && !isAppShell()) {
      main = <RouteFallback />;
    } else {
      main = loginScreen;
    }
  } else if (demoExpired && isDemoProfile(profile)) {
    main = (
      <NativeScrollRoot>
        <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
          <div className="glass-panel" style={{ maxWidth: 520, padding: '2rem', textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-display)' }}>Demo expired</h2>
            <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
              The 3-day demo sandbox has ended. Register your company to continue using Scorr.
            </p>
            <a href="/" className="btn btn-primary">Register your company</a>
            <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.5rem' }} onClick={handleLogout}>Sign out</button>
          </div>
        </div>
      </NativeScrollRoot>
    );
  } else if (company && company.status !== 'active' && !isPlatformOwner(profile)) {
    main = (
      <NativeScrollRoot>
        <Suspense fallback={<RouteFallback />}>
          <CompanyPendingScreen company={company} onLogout={handleLogout} />
        </Suspense>
      </NativeScrollRoot>
    );
  } else if (roleRequiresMfa(profile) && !privilegedMfaOk) {
    main = (
      <NativeScrollRoot>
        <Suspense fallback={<RouteFallback />}>
          <PrivilegedMfaGate
            fullName={profile.full_name}
            onSatisfied={() => setPrivilegedMfaOk(true)}
            onCancel={() => {
              void supabase.auth.signOut();
              handleLogout();
            }}
          />
        </Suspense>
      </NativeScrollRoot>
    );
  } else {
    main = (
      <NativeScrollRoot>
        {mfaLinkMsg && (
          <div className="login-error-banner" role="status" style={{ margin: '0.75rem 1rem 0' }}>
            {mfaLinkMsg}
            <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.5rem', padding: '0.2rem 0.5rem' }} onClick={() => setMfaLinkMsg('')}>
              Dismiss
            </button>
          </div>
        )}
        <div className={`dashboard-container${profile.role === 'admin' || profile.role === 'manager' || profile.role === 'employee' || profile.role === 'hr' ? ' dashboard-container--admin' : ''}`}>
          {isDemoProfile(profile) && <DemoModeBanner />}
          <Suspense fallback={<RouteFallback />}>
            <Header profile={profile} organizationName={company?.name} onLogout={handleLogout} />

            <main className="dashboard-main" style={{ marginTop: profile.role === 'admin' || profile.role === 'manager' || profile.role === 'hr' ? 0 : '1rem' }}>
              {(profile.role === 'admin' || profile.role === 'hr') && (
                <AdminDashboard profile={profile} organizationName={company?.name} />
              )}
              {profile.role === 'manager' && (
                <ManagerDashboard profile={profile} organizationName={company?.name} />
              )}
              {profile.role === 'employee' && <EmployeeDashboard profile={profile} />}
            </main>
          </Suspense>
        </div>
      </NativeScrollRoot>
    );
  }

  return (
    <>
      {geoTracker}
      {main}
    </>
  );
}

export default PortalApp;

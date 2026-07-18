import { useState, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { Profile } from './utils/kpiHelpers';
import LandingPage from './components/LandingPage';
import AppLoginScreen from './components/AppLoginScreen';
import NativeScrollRoot from './components/NativeScrollRoot';
import DemoModeBanner from './components/DemoModeBanner';
import PlatformOwnerPortal from './components/PlatformOwnerPortal';
import CompanyPendingScreen from './components/CompanyPendingScreen';
import { isAppShell, isNativeApp } from './utils/nativePlatform';
import { SplashScreen } from '@capacitor/splash-screen';
import { applyBranding, fetchCompanyBranding, loadBranding } from './lib/branding';
import { isDemoProfile } from './utils/demoMode';
import { isPlatformRoute, fetchMyCompany, Company } from './utils/companyHelpers';
import { useSupabaseRealtime } from './utils/useSupabaseRealtime';
import Header from './components/Header';
import EmployeeDashboard from './components/EmployeeDashboard';
import ManagerDashboard from './components/ManagerDashboard';
import AdminDashboard from './components/AdminDashboard';
import GeoAttendanceTracker from './components/GeoAttendanceTracker';
import { Loader2, AlertCircle } from 'lucide-react';

function App() {
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoExpired, setDemoExpired] = useState(false);

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

      // Platform owner uses Admin Dashboard → Registered Companies tab (not org admin tools)

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
    supabase.auth.getSession().then(({ data: { session: activeSession } }) => {
      setSession(activeSession);
      if (activeSession?.user) {
        fetchUserProfile(activeSession.user.id).then(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, activeSession) => {
      setSession(activeSession);
      if (activeSession?.user) {
        setLoading(true);
        fetchUserProfile(activeSession.user.id).then(() => setLoading(false));
      } else {
        setProfile(null);
        setCompany(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
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
    setSession(activeSession);
    setLoading(true);
    setError('');
    if (activeSession?.user?.id) {
      await fetchUserProfile(activeSession.user.id);
    }
    setLoading(false);
  };

  const handleLogout = () => {
    setSession(null);
    setProfile(null);
    setCompany(null);
    applyBranding(loadBranding(false));
  };

  if (isPlatformRoute()) {
    return (
      <NativeScrollRoot>
        <PlatformOwnerPortal />
      </NativeScrollRoot>
    );
  }

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

  if (loading) {
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
          <button className="btn btn-secondary" style={{ marginTop: '1.5rem', marginLeft: '0.5rem' }} onClick={() => supabase.auth.signOut()}>Sign Out</button>
        </div>
      </div>
    );
    return <NativeScrollRoot>{errorView}</NativeScrollRoot>;
  }

  if (!session || !profile) {
    if (isAppShell()) {
      return (
        <NativeScrollRoot>
          <AppLoginScreen onLoginSuccess={handleLoginSuccess} />
        </NativeScrollRoot>
      );
    }
    return <LandingPage onLoginSuccess={handleLoginSuccess} />;
  }

  if (demoExpired && isDemoProfile(profile)) {
    return (
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
  }

  if (company && company.status !== 'active') {
    return (
      <NativeScrollRoot>
        <CompanyPendingScreen company={company} onLogout={handleLogout} />
      </NativeScrollRoot>
    );
  }

  return (
    <NativeScrollRoot>
      <div className={`dashboard-container${profile.role === 'admin' ? ' dashboard-container--admin' : ''}`}>
        {isDemoProfile(profile) && <DemoModeBanner />}
        <Header profile={profile} onLogout={handleLogout} />

        {(profile.role === 'employee' || profile.role === 'manager') && (
          <GeoAttendanceTracker profile={profile} />
        )}

        <main className="dashboard-main" style={{ marginTop: profile.role === 'admin' ? 0 : '1rem' }}>
          {profile.role === 'admin' && <AdminDashboard profile={profile} />}
          {profile.role === 'manager' && <ManagerDashboard profile={profile} />}
          {profile.role === 'employee' && <EmployeeDashboard profile={profile} />}
        </main>
      </div>
    </NativeScrollRoot>
  );
}

export default App;

import { useState, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { Profile } from './utils/kpiHelpers';
import LandingPage from './components/LandingPage';
import Header from './components/Header';
import EmployeeDashboard from './components/EmployeeDashboard';
import ManagerDashboard from './components/ManagerDashboard';
import AdminDashboard from './components/AdminDashboard';
import { Loader2, AlertCircle } from 'lucide-react';

function App() {
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fetch public profile role details linked with Auth user
  const fetchUserProfile = async (userId: string) => {
    try {
      const { data, error: profileError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

      if (profileError) {
        // If the table doesn't exist, it is likely the schema has not been run
        if (profileError.code === 'PGRST116' || profileError.message.includes('does not exist')) {
          setError('Supabase connection works, but schema tables are not initialized. Please run schema.sql first.');
        } else {
          setError(profileError.message);
        }
        setProfile(null);
      } else {
        setProfile(data);
        setError('');
      }
    } catch (err: any) {
      setError(err.message || 'Error loading profile data.');
      setProfile(null);
    }
  };

  useEffect(() => {
    // 1. Get initial session
    supabase.auth.getSession().then(({ data: { session: activeSession } }) => {
      setSession(activeSession);
      if (activeSession?.user) {
        fetchUserProfile(activeSession.user.id).then(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // 2. Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, activeSession) => {
      setSession(activeSession);
      if (activeSession?.user) {
        setLoading(true);
        fetchUserProfile(activeSession.user.id).then(() => setLoading(false));
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleLogout = () => {
    setSession(null);
    setProfile(null);
  };

  if (!isSupabaseConfigured) {
    return (
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
  }

  // Main Loading View
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', gap: '1rem' }}>
        <Loader2 size={36} className="animate-spin" style={{ color: 'var(--accent-primary)', animation: 'spin 1.5s linear infinite' }} />
        <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Initializing HR Portal...</span>
      </div>
    );
  }

  // Database/Schema Error View
  if (session && error) {
    return (
      <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '560px', padding: '2.5rem', textAlign: 'center', borderLeft: '4px solid var(--color-danger)' }}>
          <AlertCircle size={40} style={{ color: 'var(--color-danger)', marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.5rem', fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>Database Configuration Needed</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            {error}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', direction: 'ltr', textAlign: 'left', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: 'var(--border-radius-sm)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            <strong>How to resolve:</strong>
            <div>1. Open your Supabase project dashboard.</div>
            <div>2. Go to the SQL Editor and copy/paste contents from <code>supabase/schema.sql</code>, then run it.</div>
            <div>3. Copy/paste contents from <code>supabase/seed.sql</code>, then run it to create mock profiles.</div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: '1.5rem' }} onClick={() => window.location.reload()}>
            Retry Connection
          </button>
          <button className="btn btn-secondary" style={{ marginTop: '1.5rem', marginLeft: '0.5rem' }} onClick={() => supabase.auth.signOut()}>
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // Not Authenticated View
  if (!session || !profile) {
    return <LandingPage onLoginSuccess={(activeSession) => setSession(activeSession)} />;
  }

  // Authenticated Dashboard Views
  return (
    <div className="dashboard-container">
      {/* Mounted Layout Header */}
      <Header profile={profile} onLogout={handleLogout} />

      {/* Role Dashboard Routing */}
      <main style={{ marginTop: '1rem' }}>
        {profile.role === 'admin' && <AdminDashboard profile={profile} />}
        {profile.role === 'manager' && <ManagerDashboard profile={profile} />}
        {profile.role === 'employee' && <EmployeeDashboard profile={profile} />}
      </main>
    </div>
  );
}

export default App;

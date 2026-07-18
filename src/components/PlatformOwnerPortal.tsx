import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { isPlatformOwner } from '../utils/companyHelpers';
import Login from './Login';
import PlatformCompaniesConsole from './PlatformCompaniesConsole';
import { Shield, Loader2, X } from 'lucide-react';

type AlertKind = 'success' | 'error';

export default function PlatformOwnerPortal() {
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<{ kind: AlertKind; text: string } | null>(null);

  const loadProfile = async (userId: string) => {
    const { data, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error || !data || !isPlatformOwner(data)) {
      setProfile(null);
      return false;
    }
    setProfile(data);
    return true;
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (s?.user) {
        const ok = await loadProfile(s.user.id);
        if (!ok) {
          await supabase.auth.signOut();
          setSession(null);
          setAlert({
            kind: 'error',
            text: 'Access denied. This console is only for the platform owner (info@walfia.ai). Company admins cannot view registered companies here.',
          });
        } else {
          setSession(s);
        }
      } else {
        setSession(null);
      }
      setLoading(false);
    });
  }, []);

  const handleLogin = async (s: { user: { id: string } }) => {
    setLoading(true);
    setAlert(null);
    const ok = await loadProfile(s.user.id);
    if (!ok) {
      await supabase.auth.signOut();
      setSession(null);
      setAlert({
        kind: 'error',
        text: 'This console is only for the platform owner (info@walfia.ai). Organization admins must use the company login.',
      });
    } else {
      setSession(s);
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
  };

  if (loading) {
    return (
      <div className="platform-loading">
        <Loader2 className="animate-spin" size={32} style={{ color: 'var(--accent-primary)' }} />
        Loading platform console…
      </div>
    );
  }

  if (!session || !profile) {
    return (
      <div className="platform-page platform-page--login">
        <div className="glass-panel platform-login-card">
          <div className="platform-login-card__hero">
            <div className="platform-login-card__icon">
              <Shield size={26} />
            </div>
            <h1 className="platform-login-card__title">Scorr Platform Console</h1>
            <p className="platform-login-card__subtitle">
              Owner access only — info@walfia.ai<br />
              Review company registrations, approvals, and platform alerts. Separate from organization admin login.
            </p>
          </div>
          <div className="platform-login-card__body">
            {alert && (
              <div className={`platform-alert platform-alert--${alert.kind}`} style={{ marginBottom: '1rem' }}>
                <span>{alert.text}</span>
                <button type="button" className="platform-alert__dismiss" onClick={() => setAlert(null)} aria-label="Dismiss">
                  <X size={16} />
                </button>
              </div>
            )}
            <Login onLoginSuccess={handleLogin} title="Platform Owner Sign In" showDemoShortcuts={false} embedded />
          </div>
        </div>
        <div className="platform-login-card__footer">
          <a href="/">← Back to Scorr website</a>
        </div>
      </div>
    );
  }

  return (
    <PlatformCompaniesConsole
      profile={profile}
      onLogout={() => void handleLogout()}
    />
  );
}

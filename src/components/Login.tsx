import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, Mail, Loader2 } from 'lucide-react';
import BrandLogo from './BrandLogo';
import DemoLoginShortcuts from './DemoLoginShortcuts';
import { isNativeApp } from '../utils/nativePlatform';

interface LoginProps {
  onLoginSuccess: (session: any) => void;
  /** When true, renders only the card (for embedding in landing page). */
  embedded?: boolean;
  /** Show one-click demo account buttons */
  showDemoShortcuts?: boolean;
  /** Installed app (APK) — minimal sign-in only */
  appMode?: boolean;
}

export default function Login({ onLoginSuccess, embedded = false, showDemoShortcuts = true, appMode = false }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill in all fields.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
      } else if (data.session) {
        onLoginSuccess(data.session);
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };


  const card = (
      <div className={`glass-panel login-card animate-fade-in ${embedded ? 'login-card--embedded' : ''} ${appMode ? 'login-card--app' : ''}`}>
        
        <div className="login-brand">
          <BrandLogo variant="login" alt={appMode ? 'Scorr' : 'Scorr — scorr.walfia.ai'} />
          <p className="login-brand-sub">{appMode ? 'Sign in to your workspace' : embedded ? 'Sign in to continue' : isNativeApp() ? 'Scorr HR — sign in' : 'Sign in to continue'}</p>
        </div>

        {error && (
          <div style={{ 
            background: 'var(--color-danger-bg)', 
            color: 'var(--color-danger)', 
            padding: '0.75rem 1rem', 
            borderRadius: 'var(--border-radius-sm)', 
            fontSize: '0.875rem', 
            marginBottom: '1.5rem',
            borderLeft: '3px solid var(--color-danger)'
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="email" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Mail size={14} /> Email Address
            </label>
            <input
              id="email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="password" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Lock size={14} /> Password
            </label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={loading}>
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
                Signing in...
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* CSS Spin Keyframe style */}
        <style dangerouslySetInnerHTML={{__html: `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}} />

        {showDemoShortcuts && <DemoLoginShortcuts onLoginSuccess={onLoginSuccess} />}

      </div>
  );

  if (embedded) return card;

  if (appMode) {
    return <div className="app-login-screen">{card}</div>;
  }

  return (
    <div className="login-page">
      {card}
    </div>
  );
}

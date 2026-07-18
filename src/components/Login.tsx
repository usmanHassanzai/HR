import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, Mail, Loader2, LogIn, Building2 } from 'lucide-react';
import BrandLogo from './BrandLogo';
import DemoLoginShortcuts from './DemoLoginShortcuts';
import CompanyRegister from './CompanyRegister';
import { isNativeApp } from '../utils/nativePlatform';

interface LoginProps {
  onLoginSuccess: (session: any) => void;
  /** When true, renders only the card (for embedding in landing page). */
  embedded?: boolean;
  /** Show one-click demo account buttons */
  showDemoShortcuts?: boolean;
  /** Installed app (APK) — minimal sign-in only */
  appMode?: boolean;
  /** Label above demo shortcut buttons */
  demoSectionLabel?: string;
  /** Override sign-in card title */
  title?: string;
  /** Allow switching to company registration from the login screen */
  enableCompanyRegister?: boolean;
  /** Controlled auth mode when company registration is enabled */
  authMode?: 'login' | 'register';
  onAuthModeChange?: (mode: 'login' | 'register') => void;
}

function AuthModeTabs({
  mode,
  onChange,
  compact = false,
}: {
  mode: 'login' | 'register';
  onChange: (mode: 'login' | 'register') => void;
  compact?: boolean;
}) {
  return (
    <div className={`auth-mode-tabs${compact ? ' auth-mode-tabs--compact' : ''}`} role="tablist" aria-label="Authentication mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'login'}
        className={`auth-mode-tabs__btn${mode === 'login' ? ' auth-mode-tabs__btn--active' : ''}`}
        onClick={() => onChange('login')}
      >
        <LogIn size={16} />
        Sign In
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'register'}
        className={`auth-mode-tabs__btn${mode === 'register' ? ' auth-mode-tabs__btn--active' : ''}`}
        onClick={() => onChange('register')}
      >
        <Building2 size={16} />
        Register Company
      </button>
    </div>
  );
}

export default function Login({
  onLoginSuccess,
  embedded = false,
  showDemoShortcuts = true,
  appMode = false,
  demoSectionLabel,
  title,
  enableCompanyRegister = false,
  authMode: authModeProp,
  onAuthModeChange,
}: LoginProps) {
  const [internalMode, setInternalMode] = useState<'login' | 'register'>('login');
  const authMode = authModeProp ?? internalMode;

  const setAuthMode = (mode: 'login' | 'register') => {
    onAuthModeChange?.(mode);
    if (authModeProp === undefined) setInternalMode(mode);
  };

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

  const loginSubtitle =
    title ??
    (appMode
      ? 'Sign in to your workspace'
      : embedded
        ? authMode === 'register'
          ? 'Create your organization account'
          : 'Sign in to continue'
        : isNativeApp()
          ? 'Scorr HR — sign in'
          : 'Sign in to your company workspace');

  const loginCard = (
    <div className={`glass-panel login-card animate-fade-in ${embedded ? 'login-card--embedded' : ''} ${appMode ? 'login-card--app' : ''}`}>
      {enableCompanyRegister && (
        <AuthModeTabs mode={authMode} onChange={setAuthMode} compact={embedded || appMode} />
      )}

      {authMode === 'register' && enableCompanyRegister ? (
        <CompanyRegister
          embedded
          onBack={() => setAuthMode('login')}
          onRegistered={() => setAuthMode('login')}
        />
      ) : (
        <>
          <div className="login-brand">
            <BrandLogo variant="login" alt={appMode ? 'Scorr' : 'Scorr — scorr.walfia.ai'} />
            <p className="login-brand-sub">{loginSubtitle}</p>
          </div>

          {error && (
            <div className="login-error-banner">{error}</div>
          )}

          <form onSubmit={handleLogin} className="login-form">
            <div className="form-group login-form__group">
              <label htmlFor="email">
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

            <div className="form-group login-form__group">
              <label htmlFor="password">
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

            <button type="submit" className="btn btn-primary login-form__submit" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 size={16} className="spin-icon" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {enableCompanyRegister && (
            <div className="login-register-cta">
              <p>New organization?</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAuthMode('register')}>
                <Building2 size={14} /> Register your company
              </button>
            </div>
          )}

          {showDemoShortcuts && (
            <DemoLoginShortcuts
              onLoginSuccess={onLoginSuccess}
              showDisclaimer={!appMode}
              sectionLabel={demoSectionLabel ?? (appMode ? 'Demo accounts' : '3-day demo sandbox')}
            />
          )}
        </>
      )}
    </div>
  );

  if (embedded) return loginCard;

  if (appMode) {
    return <div className="app-login-screen">{loginCard}</div>;
  }

  return (
    <div className="login-page">
      {loginCard}
    </div>
  );
}

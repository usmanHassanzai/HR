import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, Mail, Loader2, LogIn, Building2 } from 'lucide-react';
import BrandLogo from './BrandLogo';
import PasswordField from './PasswordField';
import DemoLoginShortcuts from './DemoLoginShortcuts';
import CompanyRegister from './CompanyRegister';
import { isNativeApp } from '../utils/nativePlatform';
import { loginFailureMessage } from '../utils/loginErrors';
import { requestForgotPassword } from '../utils/forgotPassword';
import { assertForgotAllowed, assertLoginAllowed, recordLoginAttempt } from '../utils/loginSecurity';

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
  const [info, setInfo] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill in all fields.');
      return;
    }
    if (!acceptedPolicy) {
      setError('Please agree to the monitoring and data usage policy to continue.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await assertLoginAllowed(email);
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        await recordLoginAttempt({ email, success: false, acceptedPolicy: true });
        setError(loginFailureMessage(authError.message));
      } else if (data.session) {
        await recordLoginAttempt({ email, success: true, acceptedPolicy: true });
        onLoginSuccess(data.session);
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Enter your registered email address.');
      return;
    }
    setLoading(true);
    setError('');
    setInfo('');
    try {
      await assertForgotAllowed(email);
      await requestForgotPassword(email);
      await recordLoginAttempt({ email, success: true, event: 'forgot' });
      setEmail('');
      setPassword('');
      setError('');
      setInfo('A new password has been sent if that email is registered. You can enter another email if needed.');
    } catch (err: any) {
      setError(err.message || 'Could not send the password. Try again.');
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
          onSession={onLoginSuccess}
        />
      ) : (
        <>
          {(!embedded || appMode) && (
          <div className="login-brand">
            <BrandLogo variant="login" alt={appMode ? 'Scorr' : 'Scorr — scorr.walfia.ai'} />
            <p className="login-brand-sub">{loginSubtitle}</p>
          </div>
          )}

          {error && (
            <div className="login-error-banner">{error}</div>
          )}
          {info && (
            <div className="login-success-banner">{info}</div>
          )}

          {forgotMode ? (
          <form onSubmit={handleForgotPassword} className="login-form" autoComplete="off">
            <div className="form-group login-form__group">
              <label htmlFor="forgot-email">
                <Mail size={14} /> Registered email
              </label>
              <input
                id="forgot-email"
                name="scorr-forgot-email"
                type="email"
                placeholder="name@company.com"
                value={email}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (info) setInfo('');
                }}
                disabled={loading}
                required
              />
            </div>
            <p className="login-forgot-hint">
              We will email a new password to this address if it belongs to an employee, manager, or admin account.
            </p>
            <button type="submit" className="btn btn-primary login-form__submit" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 size={16} className="spin-icon" />
                  Sending…
                </>
              ) : (
                'Send password'
              )}
            </button>
            <button
              type="button"
              className="login-forgot-link"
              disabled={loading}
              onClick={() => {
                setForgotMode(false);
                setError('');
                setInfo('');
                setEmail('');
                setPassword('');
              }}
            >
              Back to sign in
            </button>
          </form>
          ) : (
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
              <PasswordField
                id="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="button"
              className="login-forgot-link"
              disabled={loading}
              onClick={() => {
                setForgotMode(true);
                setError('');
                setInfo('');
                setEmail('');
                setPassword('');
              }}
            >
              Forgot password?
            </button>

            <label className="login-policy">
              <input
                type="checkbox"
                checked={acceptedPolicy}
                onChange={(e) => setAcceptedPolicy(e.target.checked)}
                disabled={loading}
              />
              <span>
                I agree to the company&apos;s monitoring and data usage policy, including attendance
                location at clock-in and clock-out and KPI performance records.
              </span>
            </label>

            <button type="submit" className="btn btn-primary login-form__submit" disabled={loading || !acceptedPolicy}>
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
          )}

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
              policyAccepted={acceptedPolicy}
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

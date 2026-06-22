import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, Mail, Shield, Users, User, Loader2 } from 'lucide-react';
import BrandLogo from './BrandLogo';

interface LoginProps {
  onLoginSuccess: (session: any) => void;
  /** When true, renders only the card (for embedding in landing page). */
  embedded?: boolean;
}

export default function Login({ onLoginSuccess, embedded = false }: LoginProps) {
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

  const handleShortcutLogin = async (roleEmail: string, rolePass: string) => {
    setLoading(true);
    setError('');
    setEmail(roleEmail);
    setPassword(rolePass);

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: roleEmail,
        password: rolePass,
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
      <div className={`glass-panel login-card animate-fade-in ${embedded ? 'login-card--embedded' : ''}`}>
        
        <div className="login-brand">
          <BrandLogo variant="login" alt="Scorr — scorr.walfia.ai" />
          <p className="login-brand-sub">Sign in to continue</p>
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

        <div style={{ margin: '2rem 0 1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }}></div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Testing Shortcuts</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }}></div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <button 
            type="button" 
            className="btn btn-secondary login-shortcut"
            onClick={() => handleShortcutLogin('employee@walfia.ai', 'employee123')}
            disabled={loading}
          >
            <User size={16} style={{ color: 'var(--color-success)' }} />
            <div style={{ textAlign: 'left', flex: 1 }}>
              <strong style={{ display: 'block' }}>Log in as Employee</strong>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Jim Halpert &bull; employee@walfia.ai</span>
            </div>
          </button>

          <button 
            type="button" 
            className="btn btn-secondary login-shortcut"
            onClick={() => handleShortcutLogin('manager@walfia.ai', 'manager123')}
            disabled={loading}
          >
            <Users size={16} style={{ color: 'var(--color-warning)' }} />
            <div style={{ textAlign: 'left', flex: 1 }}>
              <strong style={{ display: 'block' }}>Log in as Manager</strong>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Michael Scott &bull; manager@walfia.ai</span>
            </div>
          </button>

          <button 
            type="button" 
            className="btn btn-secondary login-shortcut"
            onClick={() => handleShortcutLogin('admin@walfia.ai', 'admin123')}
            disabled={loading}
          >
            <Shield size={16} style={{ color: 'var(--accent-primary)' }} />
            <div style={{ textAlign: 'left', flex: 1 }}>
              <strong style={{ display: 'block' }}>Log in as Admin</strong>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sarah Jenkins &bull; admin@walfia.ai</span>
            </div>
          </button>
        </div>

      </div>
  );

  if (embedded) return card;

  return (
    <div className="login-page">
      {card}
    </div>
  );
}

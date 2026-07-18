import { useState } from 'react';
import { Shield, Users, User, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { DEMO_ACCOUNTS } from '../utils/demoMode';

const ICONS = {
  shield: Shield,
  users: Users,
  user: User,
} as const;

interface DemoLoginShortcutsProps {
  onLoginSuccess: (session: unknown) => void;
  /** Show sandbox disclaimer above buttons */
  showDisclaimer?: boolean;
  /** Section label above the divider */
  sectionLabel?: string;
}

export default function DemoLoginShortcuts({
  onLoginSuccess,
  showDisclaimer = true,
  sectionLabel = 'Demo Sandbox',
}: DemoLoginShortcutsProps) {
  const [loadingEmail, setLoadingEmail] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleShortcutLogin = async (email: string, password: string) => {
    setLoadingEmail(email);
    setError('');

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) setError(authError.message);
      else if (data.session) onLoginSuccess(data.session);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoadingEmail(null);
    }
  };

  return (
    <>
      {error && (
        <div
          style={{
            background: 'var(--color-danger-bg)',
            color: 'var(--color-danger)',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--border-radius-sm)',
            fontSize: '0.875rem',
            marginBottom: '1rem',
            borderLeft: '3px solid var(--color-danger)',
          }}
        >
          {error}
        </div>
      )}

      {sectionLabel && (
        <div style={{ margin: '0 0 1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {sectionLabel}
          </span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
        </div>
      )}

      {showDisclaimer && (
        <p
          style={{
            fontSize: '0.78rem',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            marginBottom: '1rem',
            padding: '0.65rem 0.75rem',
            background: 'var(--color-warning-bg)',
            borderRadius: 'var(--border-radius-sm)',
            border: '1px solid rgba(251, 191, 36, 0.2)',
          }}
        >
          Demo accounts are isolated for 3 days. Anything you change here only affects demo data — not your real company setup.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {DEMO_ACCOUNTS.map((account) => {
          const Icon = ICONS[account.icon];
          const busy = loadingEmail === account.email;
          const disabled = loadingEmail !== null;

          return (
            <button
              key={account.email}
              type="button"
              className="btn btn-secondary login-shortcut"
              onClick={() => handleShortcutLogin(account.email, account.password)}
              disabled={disabled}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Icon size={16} style={{ color: account.accent }} />
              )}
              <div style={{ textAlign: 'left', flex: 1 }}>
                <strong style={{ display: 'block' }}>Log in as {account.roleLabel}</strong>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {account.personName} &bull; {account.email}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

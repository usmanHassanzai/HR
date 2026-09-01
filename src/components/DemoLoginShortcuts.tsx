import { useState } from 'react';
import { Shield, Users, User, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { DEMO_ACCOUNTS } from '../utils/demoMode';
import { loginFailureMessage } from '../utils/loginErrors';
import { assertLoginAllowed, recordLoginAttempt } from '../utils/loginSecurity';

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
  policyAccepted?: boolean;
}

export default function DemoLoginShortcuts({
  onLoginSuccess,
  showDisclaimer = true,
  sectionLabel = 'Demo Sandbox',
  policyAccepted = false,
}: DemoLoginShortcutsProps) {
  const [loadingEmail, setLoadingEmail] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleShortcutLogin = async (email: string, password: string) => {
    setLoadingEmail(email);
    setError('');

    try {
      if (!policyAccepted) {
        setError('Please agree to the monitoring and data usage policy above before signing in.');
        return;
      }
      await assertLoginAllowed(email);
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        await recordLoginAttempt({ email, success: false, acceptedPolicy: true });
        setError(loginFailureMessage(authError.message));
      } else if (data.session) {
        await recordLoginAttempt({ email, success: true, acceptedPolicy: true });
        onLoginSuccess(data.session);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoadingEmail(null);
    }
  };

  return (
    <div className="login-demo">
      {error && <div className="login-demo__error">{error}</div>}

      {sectionLabel && (
        <div className="login-demo__divider">
          <span>{sectionLabel}</span>
        </div>
      )}

      {showDisclaimer && (
        <p className="login-demo__note">
          Isolated demo data only — changes here do not affect a real company workspace.
        </p>
      )}

      <div className="login-demo__list">
        {DEMO_ACCOUNTS.map((account) => {
          const Icon = ICONS[account.icon];
          const busy = loadingEmail === account.email;
          const disabled = loadingEmail !== null || !policyAccepted;

          return (
            <button
              key={account.email}
              type="button"
              className="btn btn-secondary login-shortcut"
              onClick={() => handleShortcutLogin(account.email, account.password)}
              disabled={disabled}
            >
              {busy ? (
                <Loader2 size={16} className="spin-icon" />
              ) : (
                <Icon size={16} style={{ color: account.accent }} />
              )}
              <span>
                <strong>Log in as {account.roleLabel}</strong>
                <small>
                  {account.personName} · {account.email}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

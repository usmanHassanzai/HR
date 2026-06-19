import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2 } from 'lucide-react';

type Provider = 'azure' | 'google';

interface SSOButtonsProps {
  disabled?: boolean;
  onError?: (message: string) => void;
}

/**
 * Phase 3 — Single Sign-On.
 *
 * Uses Supabase OAuth so staff sign in with their existing company identity
 * (Microsoft Entra / Azure AD for company email, or Google Workspace).
 * Providers must be enabled + configured with client credentials in the
 * Supabase dashboard (Authentication → Providers) for these to complete.
 */
export default function SSOButtons({ disabled, onError }: SSOButtonsProps) {
  const [pending, setPending] = useState<Provider | null>(null);

  const signIn = async (provider: Provider) => {
    setPending(provider);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: window.location.origin,
          scopes: provider === 'azure' ? 'email openid profile' : undefined,
        },
      });
      if (error) {
        onError?.(
          `${provider === 'azure' ? 'Microsoft' : 'Google'} SSO is not enabled yet: ${error.message}`
        );
        setPending(null);
      }
      // On success the browser redirects to the provider.
    } catch (err: any) {
      onError?.(err.message || 'SSO failed to start.');
      setPending(null);
    }
  };

  const btnStyle: React.CSSProperties = {
    justifyContent: 'center',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    gap: '0.6rem',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <button
        type="button"
        className="btn btn-secondary"
        style={btnStyle}
        onClick={() => signIn('azure')}
        disabled={disabled || pending !== null}
      >
        {pending === 'azure' ? (
          <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
        ) : (
          <MicrosoftIcon />
        )}
        Continue with Microsoft
      </button>

      <button
        type="button"
        className="btn btn-secondary"
        style={btnStyle}
        onClick={() => signIn('google')}
        disabled={disabled || pending !== null}
      >
        {pending === 'google' ? (
          <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
        ) : (
          <GoogleIcon />
        )}
        Continue with Google
      </button>
    </div>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.1-11.3-7.6l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.6l6.3 5.2C41.4 36.4 44 30.8 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  );
}

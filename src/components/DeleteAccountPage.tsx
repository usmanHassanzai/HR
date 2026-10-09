import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Shield, Trash2 } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import ScorrWordmark from './ScorrWordmark';
import { supabase } from '../lib/supabase';
import DeleteAccountSection from './DeleteAccountSection';
import '../styles/landing.css';

/**
 * Public App Store / Play Store account-deletion instructions + signed-in delete form.
 * Route: /delete-account
 */
export default function DeleteAccountPage() {
  const [checking, setChecking] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!cancelled) setSignedIn(Boolean(session?.user));
      } catch {
        if (!cancelled) setSignedIn(false);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="landing-page" style={{ minHeight: '100vh' }}>
      <header className="landing-nav" style={{ position: 'sticky', top: 0 }}>
        <div className="landing-nav__inner">
          <a href="/" className="landing-nav__home" aria-label="Scorr home">
            <ScorrWordmark className="landing-nav__logo" variant="header" />
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ThemeToggle />
            <a href="/#login" className="btn btn-secondary btn-sm">Sign in</a>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '2.5rem 1.25rem 4rem' }}>
        <a
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            marginBottom: '1.25rem',
            textDecoration: 'none',
          }}
        >
          <ArrowLeft size={16} /> Back to Scorr
        </a>

        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', margin: '0 0 0.65rem', letterSpacing: '-0.02em' }}>
          Delete your Scorr account
        </h1>
        <p style={{ margin: '0 0 1.75rem', color: 'var(--text-secondary)', lineHeight: 1.55, fontSize: '1rem' }}>
          You can permanently delete your Scorr account and associated personal data at any time.
          Deletion is irreversible.
        </p>

        <section
          className="glass-panel"
          style={{ padding: '1.35rem 1.4rem', marginBottom: '1.25rem' }}
        >
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '1.05rem', margin: '0 0 0.75rem' }}>
            <Trash2 size={18} /> How to request deletion
          </h2>
          <ol style={{ margin: 0, paddingLeft: '1.2rem', color: 'var(--text-secondary)', lineHeight: 1.55, fontSize: '0.92rem' }}>
            <li style={{ marginBottom: '0.55rem' }}>
              Sign in at <a href="/#login">scorr.walfia.ai</a> or in the Scorr iOS / Android app.
            </li>
            <li style={{ marginBottom: '0.55rem' }}>
              Open <strong>Settings</strong> (Account security).
            </li>
            <li style={{ marginBottom: '0.55rem' }}>
              Choose <strong>Delete my account</strong>, type <strong>DELETE</strong>, and confirm with your password.
            </li>
            <li>
              Or use the signed-in form on this page below.
            </li>
          </ol>
        </section>

        <section
          className="glass-panel"
          style={{ padding: '1.35rem 1.4rem', marginBottom: '1.25rem' }}
        >
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '1.05rem', margin: '0 0 0.75rem' }}>
            <Shield size={18} /> What is deleted
          </h2>
          <ul style={{ margin: 0, paddingLeft: '1.2rem', color: 'var(--text-secondary)', lineHeight: 1.55, fontSize: '0.92rem' }}>
            <li style={{ marginBottom: '0.45rem' }}>Your login credentials and profile</li>
            <li style={{ marginBottom: '0.45rem' }}>Your attendance, leave, KPI, task, and rewards records tied to your user</li>
            <li style={{ marginBottom: '0.45rem' }}>Authenticator factors, backup codes, and recovery settings for your account</li>
            <li>
              <strong>Company owners:</strong> if other employees remain, you must either transfer ownership or
              confirm deleting the <em>entire company</em> (all members and company data). If you are the only
              member, deleting your account also removes the empty company.
            </li>
          </ul>
        </section>

        <section className="glass-panel" style={{ padding: '1.35rem 1.4rem' }}>
          <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.75rem' }}>Delete now</h2>
          {checking ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
              <Loader2 className="spin-icon" size={22} />
            </div>
          ) : signedIn ? (
            <DeleteAccountSection
              embedded
              onDeleted={() => {
                window.location.assign('/?deleted=1');
              }}
            />
          ) : (
            <div>
              <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.5 }}>
                Sign in with the account you want to remove, then return here or use Settings → Delete my account.
              </p>
              <a href="/#login" className="btn btn-primary">
                Sign in to continue
              </a>
              <p style={{ margin: '1.1rem 0 0', fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Need help? Email{' '}
                <a href="mailto:info@walfia.ai">info@walfia.ai</a>
                {' '}from the address on your account and we will process deletion within 30 days.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

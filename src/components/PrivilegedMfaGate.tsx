import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { currentMfaLevel, clearUnverifiedTotpFactors, getVerifiedTotpFactorId, requestAuthenticatorReset } from '../utils/mfaHelpers';
import {
  fetchMfaRecoveryStatus,
  generateBackupCodes,
  hasMfaSessionGrant,
  requestLoginEmailOtp,
  verifyBackupCode,
  verifyLoginEmailOtp,
} from '../utils/mfaRecovery';
import BackupCodesRevealModal from './BackupCodesRevealModal';
import PasswordField from './PasswordField';

interface PrivilegedMfaGateProps {
  onSatisfied: () => void;
  onCancel: () => void;
  fullName?: string;
}

type GateMode = 'totp' | 'backup' | 'email';

/**
 * All production accounts must enroll/verify TOTP (or backup/email recovery)
 * before their dashboard renders. Demo accounts are skipped upstream.
 */
export default function PrivilegedMfaGate({ onSatisfied, onCancel, fullName }: PrivilegedMfaGateProps) {
  const [phase, setPhase] = useState<'loading' | 'enroll' | 'verify'>('loading');
  const [factorId, setFactorId] = useState('');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestNote, setRequestNote] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);
  const [mode, setMode] = useState<GateMode>('totp');
  const [password, setPassword] = useState('');
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [loginEmailMasked, setLoginEmailMasked] = useState<string | null>(null);
  const [needsBackupCodes, setNeedsBackupCodes] = useState(false);
  const [codesIssuePending, setCodesIssuePending] = useState(false);
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const onSatisfiedRef = useRef(onSatisfied);
  onSatisfiedRef.current = onSatisfied;

  const finishSatisfied = useCallback(() => {
    onSatisfiedRef.current();
  }, []);

  const beginEnroll = useCallback(async () => {
    setPhase('loading');
    setError('');
    setMode('totp');
    setCode('');
    setFactorId('');
    setQr('');
    setSecret('');
    setNeedsBackupCodes(true);
    setEmailOtpSent(false);
    await clearUnverifiedTotpFactors().catch(() => undefined);
    let { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Scorr authenticator',
    });
    if (enrollError && /friendly name|already exists/i.test(enrollError.message || '')) {
      await clearUnverifiedTotpFactors().catch(() => undefined);
      const retry = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Scorr ${Date.now().toString(36)}`,
      });
      data = retry.data;
      enrollError = retry.error;
    }
    if (enrollError || !data) {
      setError(enrollError?.message || 'Could not start authenticator setup.');
      setPhase('verify');
      return;
    }
    setFactorId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
    setPhase('enroll');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      setError('');
      setPhase('loading');
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!sessionData.session?.access_token) {
          setError('Your session expired. Sign out, sign in again, then continue.');
          setPhase('verify');
          return;
        }

        const level = await currentMfaLevel();
        if (cancelled) return;

        const verifiedIdEarly = await getVerifiedTotpFactorId();
        if (cancelled) return;

        // AAL2 or backup-code grant only skip the gate when a verified TOTP still exists.
        // After authenticator reset there are no factors — always force re-enroll.
        if (level === 'aal2' && verifiedIdEarly) {
          finishSatisfied();
          return;
        }

        // Don't block the gate on grant / recovery status network calls.
        const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T) =>
          Promise.race([
            p,
            new Promise<T>((resolve) => { setTimeout(() => resolve(fallback), ms); }),
          ]);
        const [grant, st] = await Promise.all([
          withTimeout(hasMfaSessionGrant().catch(() => false), 4000, false),
          withTimeout(fetchMfaRecoveryStatus().catch(() => null), 4000, null),
        ]);
        if (cancelled) return;
        if (grant && verifiedIdEarly) {
          finishSatisfied();
          return;
        }
        setLoginEmailMasked(st?.login_email || null);
        setNeedsBackupCodes(Boolean(st?.needs_codes) || !verifiedIdEarly);

        if (verifiedIdEarly) {
          setFactorId(verifiedIdEarly);
          setQr('');
          setSecret('');
          setPhase('verify');
          return;
        }

        // Leftover unfinished setups still use the name "Scorr authenticator"
        // and block a new QR — remove them, then enroll once.
        await clearUnverifiedTotpFactors().catch(() => undefined);
        if (cancelled) return;

        let { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          friendlyName: 'Scorr authenticator',
        });

        if (enrollError && /friendly name|already exists/i.test(enrollError.message || '')) {
          await clearUnverifiedTotpFactors().catch(() => undefined);
          const retry = await supabase.auth.mfa.enroll({
            factorType: 'totp',
            friendlyName: `Scorr ${Date.now().toString(36)}`,
          });
          data = retry.data;
          enrollError = retry.error;
        }

        if (cancelled) return;
        if (enrollError || !data) {
          setError(
            enrollError?.message?.includes('already exists')
              ? 'A previous authenticator setup was left unfinished. Sign out and sign in again to get a fresh QR code.'
              : (enrollError?.message || 'Could not start authenticator setup.'),
          );
          setPhase('verify');
          return;
        }
        setFactorId(data.id);
        setQr(data.totp.qr_code);
        setSecret(data.totp.secret);
        setPhase('enroll');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not open authenticator setup.');
        setPhase('verify');
      }
    };

    void boot();
    return () => { cancelled = true; };
  }, [finishSatisfied]);

  const issueBackupCodes = async (opts: { password?: string; totpCode?: string }) => {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      console.warn('refresh after MFA verify:', refreshError.message);
    }
    // Ensure invoke uses the AAL2 access token from verify/refresh.
    if (refreshed.session?.access_token) {
      await supabase.auth.setSession({
        access_token: refreshed.session.access_token,
        refresh_token: refreshed.session.refresh_token,
      });
    }
    const codes = await generateBackupCodes(opts.password || '', opts.totpCode);
    setFreshCodes(codes);
    setNeedsBackupCodes(false);
    setCodesIssuePending(false);
  };

  const afterTotpOk = async (wasEnroll: boolean, totpCode: string) => {
    // Always show backup codes after first enroll, or when the account has none left.
    const st = await fetchMfaRecoveryStatus().catch(() => null);
    const mustIssue = wasEnroll || Boolean(st?.needs_codes) || needsBackupCodes;
    if (!mustIssue) {
      finishSatisfied();
      return;
    }
    try {
      await issueBackupCodes({ password: password || undefined, totpCode });
      // Stay on gate until BackupCodesRevealModal acknowledge → finishSatisfied.
    } catch (e) {
      setCodesIssuePending(true);
      setError(
        e instanceof Error
          ? `${e.message} Enter your password below and tap “Show backup codes”.`
          : 'Could not create backup codes. Enter your password and try again.',
      );
    }
  };

  const submitTotp = async () => {
    const trimmed = code.replace(/\s/g, '');
    if (trimmed.length < 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    if (!factorId) {
      setError('Authenticator is not ready. Sign out and sign in again, or use a recovery option below.');
      return;
    }
    if (phase === 'enroll' && !password.trim()) {
      setError('Enter your account password so we can create backup codes after verification.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session?.access_token) {
        throw new Error('Your session expired. Sign out, sign in again, then continue.');
      }
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError || !challenge) throw new Error(challengeError?.message || 'Challenge failed');
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: trimmed,
      });
      if (verifyError) throw new Error(verifyError.message);
      await afterTotpOk(phase === 'enroll', trimmed);
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Invalid code. Try again.';
      if (/missing sub claim/i.test(raw)) {
        setError('Sign-in session expired. Sign out, sign in with your password, then enter a fresh code.');
      } else {
        setError(raw);
      }
    } finally {
      setBusy(false);
    }
  };

  const retryIssueCodes = async () => {
    if (!password.trim() && !code.trim()) {
      setError('Enter your password (and a current authenticator code if asked) to create backup codes.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await issueBackupCodes({ password: password.trim(), totpCode: code.replace(/\s/g, '') || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create backup codes.');
    } finally {
      setBusy(false);
    }
  };

  const submitBackup = async () => {
    if (!code.trim()) {
      setError('Enter a backup code.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await verifyBackupCode(code);
      finishSatisfied();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid backup code.');
    } finally {
      setBusy(false);
    }
  };

  const submitEmailOtp = async () => {
    if (!password) {
      setError('Enter your account password to continue.');
      return;
    }
    setBusy(true);
    setError('');
    setRequestNote('');
    try {
      if (!emailOtpSent) {
        const res = await requestLoginEmailOtp(password);
        setEmailOtpSent(true);
        setCode('');
        setLoginEmailMasked(res.emailed_to || loginEmailMasked);
        setRequestNote(
          `Verification code sent to ${res.emailed_to || 'your login email'}. It expires in ${res.expires_minutes || 20} minutes.`,
        );
        return;
      }
      const trimmed = code.replace(/\D/g, '');
      if (trimmed.length !== 6) {
        setError('Enter the 6-digit code from your email.');
        return;
      }
      await verifyLoginEmailOtp(password, trimmed);
      setRequestNote('Email verified. Set up a new authenticator and save your backup codes.');
      await beginEnroll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Email verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const askAdminReset = async () => {
    setRequestBusy(true);
    setError('');
    setRequestNote('');
    try {
      const result = await requestAuthenticatorReset() as {
        notifiedAdmins?: number;
        escalatedToPlatform?: boolean;
      } | null;
      if ((result?.notifiedAdmins || 0) > 0) {
        setRequestNote('Request sent. Your company admin was notified. After they reset it, sign out, sign in again, and scan the new QR code.');
      } else if (result?.escalatedToPlatform) {
        setRequestNote('Request sent to the Scorr platform team. After they reset it, sign out, sign in again, and scan the new QR code.');
      } else {
        setRequestNote('Request recorded. Your admin can reset it from People.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the reset request.');
    } finally {
      setRequestBusy(false);
    }
  };

  const onPrimary = () => {
    if (mode === 'backup') return void submitBackup();
    if (mode === 'email') return void submitEmailOtp();
    return void submitTotp();
  };

  return (
    <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
      {freshCodes && (
        <BackupCodesRevealModal
          codes={freshCodes}
          fullName={fullName}
          onDone={() => {
            setFreshCodes(null);
            finishSatisfied();
          }}
        />
      )}
      <div className="glass-panel" style={{ maxWidth: 460, padding: '2rem', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.75rem' }}>
          <ShieldCheck size={28} style={{ color: 'var(--accent-primary)' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', margin: 0 }}>Authenticator required</h2>
        </div>

        {phase === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '1.5rem' }}>
            <Loader2 className="animate-spin" size={28} />
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Preparing authenticator…</p>
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Sign out</button>
          </div>
        )}

        {phase === 'enroll' && qr && mode === 'totp' && (
          <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <p style={{ color: 'var(--text-secondary)', textAlign: 'left', marginBottom: '0.85rem' }}>
              Install an authenticator app, scan this QR, then enter the 6-digit code. After setup you will receive backup codes — save them.
            </p>
            <img src={qr} alt="Authenticator QR code" style={{ width: 180, height: 180, background: '#fff', borderRadius: 8 }} />
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
              Manual key: <code style={{ wordBreak: 'break-all' }}>{secret}</code>
            </p>
            <label className="form-label" htmlFor="mfa-enroll-pw" style={{ textAlign: 'left', display: 'block', marginTop: '0.85rem' }}>
              Account password <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <PasswordField
              id="mfa-enroll-pw"
              className="form-input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'left', margin: '0.35rem 0 0' }}>
              Required so we can create your one-time backup codes after verification.
            </p>
          </div>
        )}

        {phase === 'verify' && mode === 'totp' && (
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Open your authenticator app and type the current 6-digit code.
          </p>
        )}

        {phase !== 'loading' && (
          <>
            {mode === 'totp' && (
              <>
                <label className="form-label" htmlFor="mfa-code">6-digit code</label>
                <input
                  id="mfa-code"
                  className="form-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={8}
                />
              </>
            )}
            {mode === 'backup' && (
              <>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginBottom: '0.75rem' }}>
                  Enter one unused backup code (for example ABCD-EFGH). It will be burned after use.
                </p>
                <label className="form-label" htmlFor="mfa-backup">Backup code</label>
                <input
                  id="mfa-backup"
                  className="form-input"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX"
                />
              </>
            )}
            {mode === 'email' && (
              <>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginBottom: '0.75rem' }}>
                  {emailOtpSent
                    ? `Enter the 6-digit code we sent to ${loginEmailMasked || 'your login email'}. After verification you will set up a new authenticator.`
                    : `We will send a verification code to ${loginEmailMasked || 'your login email'}. Enter your account password to continue.`}
                </p>
                <label className="form-label" htmlFor="mfa-email-pw">Account password</label>
                <PasswordField
                  id="mfa-email-pw"
                  className="form-input"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {emailOtpSent && (
                  <>
                    <label className="form-label" htmlFor="mfa-email-otp" style={{ marginTop: '0.75rem' }}>
                      Email verification code
                    </label>
                    <input
                      id="mfa-email-otp"
                      className="form-input"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      maxLength={6}
                      placeholder="000000"
                    />
                  </>
                )}
              </>
            )}

            {error && (
              <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>
            )}
            {requestNote && (
              <p style={{ color: 'var(--color-success, #0f766e)', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.45 }}>{requestNote}</p>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || (mode === 'totp' && !factorId && !codesIssuePending)}
                onClick={onPrimary}
              >
                {busy
                  ? 'Working…'
                  : mode === 'email'
                    ? (emailOtpSent ? 'Verify email code' : 'Send verification code')
                    : mode === 'backup'
                      ? 'Use backup code'
                      : 'Verify and continue'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onCancel}>Sign out</button>
            </div>

            {codesIssuePending && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '0.9rem 1rem',
                  borderRadius: 10,
                  border: '1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)',
                  background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
                }}
              >
                <p style={{ margin: '0 0 0.65rem', fontWeight: 600, fontSize: '0.9rem' }}>
                  Authenticator verified — save your backup codes before continuing
                </p>
                <label className="form-label" htmlFor="mfa-codes-pw">Account password</label>
                <PasswordField
                  id="mfa-codes-pw"
                  className="form-input"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: '0.75rem', width: '100%' }}
                  disabled={busy}
                  onClick={() => void retryIssueCodes()}
                >
                  {busy ? 'Creating codes…' : 'Show backup codes'}
                </button>
              </div>
            )}

            {/* Email / backup recovery for every MFA role (admin, manager, employee, hr). */}
            <div style={{ marginTop: '1.25rem', display: 'grid', gap: '0.55rem' }}>
              {mode !== 'totp' && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setMode('totp'); setError(''); setCode(''); setEmailOtpSent(false); setRequestNote(''); }}
                >
                  {phase === 'enroll' ? 'Back to authenticator setup' : 'Back to authenticator code'}
                </button>
              )}
              {mode !== 'backup' && (
                <button
                  type="button"
                  className="login-forgot-link"
                  style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                  onClick={() => { setMode('backup'); setError(''); setCode(''); setRequestNote(''); setEmailOtpSent(false); }}
                >
                  Lost your authenticator? Use a backup code.
                </button>
              )}
              {mode !== 'email' && (
                <button
                  type="button"
                  className="login-forgot-link"
                  style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                  onClick={() => { setMode('email'); setError(''); setCode(''); setRequestNote(''); setEmailOtpSent(false); }}
                >
                  No authenticator or backup codes? Verify with your email.
                </button>
              )}
              {mode === 'email' && emailOtpSent && (
                <button
                  type="button"
                  className="login-forgot-link"
                  style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                  onClick={() => { setEmailOtpSent(false); setCode(''); setRequestNote(''); setError(''); }}
                >
                  Resend a new verification code
                </button>
              )}

              <div
                style={{
                  marginTop: '0.5rem',
                  padding: '0.9rem 1rem',
                  borderRadius: 10,
                  border: '1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent)',
                  background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                }}
              >
                <p style={{ margin: 0, fontWeight: 600, fontSize: '0.92rem' }}>Still locked out?</p>
                <p style={{ margin: '0.4rem 0 0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  If you cannot access your login email either, request an admin reset from People.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ width: '100%' }}
                  disabled={requestBusy || busy || Boolean(requestNote && /reset requested|request sent/i.test(requestNote))}
                  onClick={() => void askAdminReset()}
                >
                  {requestBusy ? 'Sending request…' : /reset requested|request sent/i.test(requestNote) ? 'Reset requested' : 'Request admin to reset authenticator'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

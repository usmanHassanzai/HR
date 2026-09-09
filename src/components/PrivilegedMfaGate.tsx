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
import '../styles/mfa-gate.css';

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
    <div className="mfa-gate">
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
      <div className="glass-panel mfa-gate__panel">
        <div className="mfa-gate__head">
          <ShieldCheck size={28} className="mfa-gate__head-icon" aria-hidden />
          <div>
            <h2 className="mfa-gate__title">Authenticator required</h2>
            <p className="mfa-gate__subtitle">
              Secure your Scorr account with an authenticator app, backup codes, or email recovery.
            </p>
          </div>
        </div>

        {phase === 'loading' && (
          <div className="mfa-gate__loading">
            <Loader2 className="animate-spin" size={28} />
            <p>Preparing authenticator…</p>
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Sign out</button>
          </div>
        )}

        {phase === 'enroll' && qr && mode === 'totp' && (
          <div className="mfa-gate__enroll">
            <p className="mfa-gate__enroll-copy">
              Install an authenticator app, scan this QR, then enter the 6-digit code. After setup you will receive backup codes — save them.
            </p>
            <img src={qr} alt="Authenticator QR code" className="mfa-gate__qr" />
            <p className="mfa-gate__secret">
              Manual key: <code>{secret}</code>
            </p>
            <label className="form-label mfa-gate__field-gap" htmlFor="mfa-enroll-pw" style={{ textAlign: 'left', display: 'block' }}>
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
            <p className="mfa-gate__hint">
              Required so we can create your one-time backup codes after verification.
            </p>
          </div>
        )}

        {phase === 'verify' && mode === 'totp' && (
          <p className="mfa-gate__copy">
            Open your authenticator app and type the current 6-digit code.
          </p>
        )}

        {phase !== 'loading' && (
          <div className="mfa-gate__body">
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
                <p className="mfa-gate__copy">
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
                <p className="mfa-gate__copy">
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
                    <label className="form-label mfa-gate__field-gap" htmlFor="mfa-email-otp">
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

            {error && <p className="mfa-gate__error">{error}</p>}
            {requestNote && <p className="mfa-gate__note">{requestNote}</p>}

            <div className="mfa-gate__actions">
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
              <div className="mfa-gate__codes-box">
                <p>Authenticator verified — save your backup codes before continuing</p>
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
                  disabled={busy}
                  onClick={() => void retryIssueCodes()}
                >
                  {busy ? 'Creating codes…' : 'Show backup codes'}
                </button>
              </div>
            )}

            <div className="mfa-gate__recovery">
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
                  className="mfa-gate__link"
                  onClick={() => { setMode('backup'); setError(''); setCode(''); setRequestNote(''); setEmailOtpSent(false); }}
                >
                  Lost your authenticator? Use a backup code.
                </button>
              )}
              {mode !== 'email' && (
                <button
                  type="button"
                  className="mfa-gate__link"
                  onClick={() => { setMode('email'); setError(''); setCode(''); setRequestNote(''); setEmailOtpSent(false); }}
                >
                  No authenticator or backup codes? Verify with your email.
                </button>
              )}
              {mode === 'email' && emailOtpSent && (
                <button
                  type="button"
                  className="mfa-gate__link"
                  onClick={() => { setEmailOtpSent(false); setCode(''); setRequestNote(''); setError(''); }}
                >
                  Resend a new verification code
                </button>
              )}

              <div className="mfa-gate__admin-box">
                <p>Still locked out?</p>
                <p>
                  If you cannot access your login email either, request an admin reset from People.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={requestBusy || busy || Boolean(requestNote && /reset requested|request sent/i.test(requestNote))}
                  onClick={() => void askAdminReset()}
                >
                  {requestBusy ? 'Sending request…' : /reset requested|request sent/i.test(requestNote) ? 'Reset requested' : 'Request admin to reset authenticator'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

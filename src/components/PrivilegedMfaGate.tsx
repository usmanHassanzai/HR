import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { currentMfaLevel, hasVerifiedTotpFactor, requestAuthenticatorReset } from '../utils/mfaHelpers';

interface PrivilegedMfaGateProps {
  onSatisfied: () => void;
  onCancel: () => void;
}

/**
 * Admins and managers must enroll and verify a TOTP app (AAL2)
 * before the privileged dashboards render.
 */
export default function PrivilegedMfaGate({ onSatisfied, onCancel }: PrivilegedMfaGateProps) {
  const [phase, setPhase] = useState<'loading' | 'enroll' | 'verify'>('loading');
  const [factorId, setFactorId] = useState('');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestNote, setRequestNote] = useState('');

  const start = useCallback(async () => {
    setError('');
    const level = await currentMfaLevel();
    if (level === 'aal2') {
      onSatisfied();
      return;
    }
    const enrolled = await hasVerifiedTotpFactor();
    if (enrolled) {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totp = (factors?.totp || []).find((f) => f.status === 'verified');
      if (totp) setFactorId(totp.id);
      setPhase('verify');
      return;
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Scorr authenticator',
    });
    if (enrollError || !data) {
      setError(enrollError?.message || 'Could not start authenticator setup.');
      setPhase('enroll');
      return;
    }
    setFactorId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
    setPhase('enroll');
  }, [onSatisfied]);

  useEffect(() => {
    void start();
  }, [start]);

  const submitCode = async () => {
    const trimmed = code.replace(/\s/g, '');
    if (trimmed.length < 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError || !challenge) throw new Error(challengeError?.message || 'Challenge failed');
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: trimmed,
      });
      if (verifyError) throw new Error(verifyError.message);
      onSatisfied();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const askAdminReset = async () => {
    setBusy(true);
    setError('');
    setRequestNote('');
    try {
      await requestAuthenticatorReset();
      setRequestNote('Your company admin was notified. After they reset it, sign in again and you will get a new QR code.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the reset request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
      <div className="glass-panel" style={{ maxWidth: 440, padding: '2rem', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.75rem' }}>
          <ShieldCheck size={28} style={{ color: 'var(--accent-primary)' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', margin: 0 }}>Authenticator required</h2>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
          A phone camera or QR scanner will not open this. Install an authenticator app
          (Google Authenticator, Microsoft Authenticator, or Authy), add Scorr there, then
          type the 6-digit code that app shows into the box below. The code changes every 30 seconds.
        </p>

        {phase === 'loading' && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
            <Loader2 className="animate-spin" size={28} />
          </div>
        )}

        {phase === 'enroll' && qr && (
          <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <img src={qr} alt="Authenticator QR code" style={{ width: 180, height: 180, background: '#fff', borderRadius: 8 }} />
            <ol style={{ textAlign: 'left', fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.85rem 0 0', paddingLeft: '1.15rem', lineHeight: 1.45 }}>
              <li>On your phone, open Google Authenticator (or Authy) — not a QR scanner.</li>
              <li>Tap add / scan QR and point the camera at this code.</li>
              <li>The app will show a 6-digit number. Type that number here.</li>
            </ol>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
              If the camera cannot scan, add a key manually in the authenticator:{' '}
              <code style={{ wordBreak: 'break-all' }}>{secret}</code>
            </p>
          </div>
        )}

        {phase !== 'loading' && (
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
            {error && (
              <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>
            )}
            {requestNote && (
              <p style={{ color: 'var(--color-success)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{requestNote}</p>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" disabled={busy || !factorId} onClick={() => void submitCode()}>
                {busy ? 'Working…' : 'Verify and continue'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onCancel}>Sign out</button>
            </div>
            {phase === 'verify' && (
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '1rem 0 0', lineHeight: 1.45 }}>
                If the authenticator app was deleted, an admin can reset it from People.
                {' '}
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: '0.65rem' }}
                  disabled={busy}
                  onClick={() => void askAdminReset()}
                >
                  I deleted my authenticator
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

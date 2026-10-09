import { useCallback, useEffect, useState } from 'react';
import { Loader2, Shield, KeyRound, Mail, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import {
  fetchMfaRecoveryStatus,
  generateBackupCodes,
  setRecoveryEmail,
  type MfaRecoveryStatus,
} from '../utils/mfaRecovery';
import {
  listTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  type TrustedDeviceRow,
} from '../utils/trustedDevice';
import BackupCodesRevealModal from './BackupCodesRevealModal';
import PasswordField from './PasswordField';
import DeleteAccountSection from './DeleteAccountSection';
import AboutUpdatesPanel from './AboutUpdatesPanel';
import { supabase } from '../lib/supabase';

interface AccountSecurityPanelProps {
  fullName?: string;
}

export default function AccountSecurityPanel({ fullName }: AccountSecurityPanelProps) {
  const [status, setStatus] = useState<MfaRecoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [recoveryEmail, setRecoveryEmailInput] = useState('');
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [audit, setAudit] = useState<{ method: string; success: boolean; created_at: string; detail?: string | null; ip_address?: string | null }[]>([]);
  const [devices, setDevices] = useState<TrustedDeviceRow[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [st, auditRes, deviceList] = await Promise.all([
      fetchMfaRecoveryStatus(),
      supabase
        .from('recovery_audit_log')
        .select('method, success, created_at, detail, ip_address')
        .order('created_at', { ascending: false })
        .limit(12),
      listTrustedDevices().catch(() => [] as TrustedDeviceRow[]),
    ]);
    setStatus(st);
    setAudit(auditRes.data || []);
    setDevices(deviceList);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onGenerate = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const codes = await generateBackupCodes(password, totp || undefined);
      setFreshCodes(codes);
      setPassword('');
      setTotp('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate codes.');
    } finally {
      setBusy(false);
    }
  };

  const onSetEmail = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await setRecoveryEmail(recoveryEmail, password);
      setNote('Confirmation link sent to that address. Open it within 20 minutes to activate recovery email.');
      setPassword('');
      setRecoveryEmailInput('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set recovery email.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
        <Loader2 className="spin-icon" size={24} />
      </div>
    );
  }

  return (
    <div className="account-security">
      {freshCodes && (
        <BackupCodesRevealModal
          codes={freshCodes}
          fullName={fullName}
          onDone={() => setFreshCodes(null)}
        />
      )}

      <div className="app-settings-block" style={{ marginBottom: '1rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0 0 0.5rem' }}>
          <Shield size={18} /> Authenticator apps
        </h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Scorr works with <strong>Google Authenticator</strong> and <strong>Microsoft Authenticator</strong>.
          Scan the same QR code in either app to get your 6-digit login codes.
        </p>
      </div>

      <div className="app-settings-block" style={{ marginBottom: '1rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0 0 0.5rem' }}>
          <KeyRound size={18} /> Backup codes
        </h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Single-use codes that unlock your account if you lose your authenticator.
          {' '}
          {status?.remaining_codes != null
            ? <strong>{status.remaining_codes} unused</strong>
            : null}
          {status?.low_codes ? ' — regenerate soon.' : '.'}
          {' '}Regenerating invalidates all old codes. Requires password + authenticator session.
        </p>
        <label className="form-label">Current password</label>
        <PasswordField className="form-input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="form-label" style={{ marginTop: '0.65rem' }}>Authenticator code (if prompted)</label>
        <input className="form-input" inputMode="numeric" maxLength={8} value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="Optional if already verified this session" />
        <button type="button" className="btn btn-primary" style={{ marginTop: '0.85rem' }} disabled={busy || !password} onClick={() => void onGenerate()}>
          {busy ? <Loader2 size={16} className="spin-icon" /> : <RefreshCw size={16} />}
          {status?.codes_generated ? 'Regenerate 10 backup codes' : 'Generate 10 backup codes'}
        </button>
      </div>

      <div className="app-settings-block" style={{ marginBottom: '1rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0 0 0.5rem' }}>
          <Mail size={18} /> Email recovery
        </h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          If you lose your authenticator and backup codes, sign in with your password and choose
          {' '}<strong>Verify with your email</strong> on the authenticator screen. A one-time code is sent to your
          login email{status?.login_email ? <> (<strong>{status.login_email}</strong>)</> : null}.
          That works for admin, manager, and employee accounts.
        </p>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Optional: set a separate recovery email below (also receives reset options).
          {status?.recovery_email_verified && status.recovery_email
            ? <> Active: <strong>{status.recovery_email}</strong></>
            : status?.recovery_email_pending
              ? <> Pending confirmation: <strong>{status.recovery_email_pending}</strong></>
              : ' Not set.'}
        </p>
        <label className="form-label">Recovery email</label>
        <input className="form-input" type="email" value={recoveryEmail} onChange={(e) => setRecoveryEmailInput(e.target.value)} placeholder="personal@email.com" />
        <label className="form-label" style={{ marginTop: '0.65rem' }}>Current password</label>
        <PasswordField className="form-input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: '0.85rem' }} disabled={busy || !password || !recoveryEmail.includes('@')} onClick={() => void onSetEmail()}>
          {busy ? <Loader2 size={16} className="spin-icon" /> : <Shield size={16} />}
          Send confirmation link
        </button>
      </div>

      <div className="app-settings-block" style={{ marginBottom: '1rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0 0 0.5rem' }}>
          <Smartphone size={18} /> Trusted devices
        </h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          After you verify with an authenticator or backup code, you can trust a device so you skip codes
          for a limited time (company policy). Tokens are stored as an HttpOnly cookie on the web, or in
          the device Keystore / Keychain / desktop secure storage in apps. Password changes, authenticator
          resets, and MFA re-enrollment revoke all trusted devices.
        </p>
        {devices.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>No trusted devices right now.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {devices.map((d) => (
              <li
                key={d.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.55rem 0',
                  borderBottom: '1px solid var(--border-color)',
                  fontSize: '0.85rem',
                }}
              >
                <div>
                  <strong>{d.label || d.platform}</strong>
                  {' · expires '}
                  {new Date(d.expires_at).toLocaleString()}
                  {d.last_used_at ? ` · last used ${new Date(d.last_used_at).toLocaleString()}` : ''}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.25rem 0.55rem', flexShrink: 0 }}
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await revokeTrustedDevice(d.id);
                        setNote('Device forgotten.');
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'Could not forget device.');
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
        {devices.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '0.75rem' }}
            disabled={busy}
            onClick={() => {
              if (!confirm('Forget all trusted devices? You will need an authenticator code on every device.')) return;
              void (async () => {
                setBusy(true);
                setError('');
                try {
                  await revokeAllTrustedDevices();
                  setNote('All trusted devices forgotten.');
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not forget devices.');
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <Trash2 size={16} /> Forget all trusted devices
          </button>
        )}
      </div>

      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem' }}>{error}</p>}
      {note && <p style={{ color: 'var(--color-success, #0f766e)', fontSize: '0.85rem' }}>{note}</p>}

      <AboutUpdatesPanel />

      <DeleteAccountSection />

      {audit.length > 0 && (
        <div className="app-settings-block">
          <h3 style={{ margin: '0 0 0.5rem' }}>Recovery audit trail</h3>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: '0.8rem' }}>
            {audit.map((row, i) => (
              <li key={`${row.created_at}-${i}`} style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--border-color)' }}>
                <strong>{row.method}</strong>
                {' · '}
                {row.success ? 'ok' : 'failed'}
                {' · '}
                {new Date(row.created_at).toLocaleString()}
                {row.ip_address ? ` · ${row.ip_address}` : ''}
                {row.detail ? ` — ${row.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

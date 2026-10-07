import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { fetchMfaTrustPolicy, saveMfaTrustPolicy } from '../utils/trustedDevice';

const STAFF_OPTIONS = [
  { value: 0, label: 'Always ask' },
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
];

const ADMIN_OPTIONS = [
  { value: 0, label: 'Always ask' },
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
];

export default function CompanyMfaTrustSettings() {
  const [staffDays, setStaffDays] = useState(7);
  const [adminDays, setAdminDays] = useState(7);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    const p = await fetchMfaTrustPolicy();
    if (p) {
      setStaffDays(p.mfa_trust_staff_days);
      setAdminDays(p.mfa_trust_admin_days);
      setCanEdit(p.can_edit);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
        <Loader2 className="spin-icon" size={22} />
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0 0 0.5rem' }}>
        <ShieldCheck size={18} /> MFA trusted devices
      </h3>
      <p style={{ margin: '0 0 0.85rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        How long employees/managers and admins/HR may trust a device after entering an authenticator
        or backup code. Platform owners always ask. Default is 7 days.
      </p>
      <label className="form-label">Employees &amp; managers</label>
      <select
        className="form-input"
        value={staffDays}
        disabled={!canEdit || busy}
        onChange={(e) => setStaffDays(Number(e.target.value))}
      >
        {STAFF_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <label className="form-label" style={{ marginTop: '0.65rem' }}>Admins &amp; HR</label>
      <select
        className="form-input"
        value={adminDays}
        disabled={!canEdit || busy}
        onChange={(e) => setAdminDays(Number(e.target.value))}
      >
        {ADMIN_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {canEdit && (
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: '0.85rem' }}
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setError('');
              setNote('');
              try {
                await saveMfaTrustPolicy(staffDays, adminDays);
                setNote('Trust policy saved.');
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not save policy.');
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? <Loader2 size={16} className="spin-icon" /> : null}
          Save trust policy
        </button>
      )}
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem' }}>{error}</p>}
      {note && <p style={{ color: 'var(--color-success, #0f766e)', fontSize: '0.85rem' }}>{note}</p>}
    </div>
  );
}

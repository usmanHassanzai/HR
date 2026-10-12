import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  MapPin,
  Radio,
  Settings2,
  ShieldOff,
  Smartphone,
  Wifi,
} from 'lucide-react';
import {
  getAutoAttendanceSaveStatus,
  openNativeAppSettings,
  openNativeBatterySettings,
  removeAccountFromAutoAttendance,
  saveAccountForAutoAttendance,
  type AutoAttendanceSaveStatus,
} from '../utils/autoAttendanceEnroll';

export default function AutoAttendanceSavePanel() {
  const [status, setStatus] = useState<AutoAttendanceSaveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getAutoAttendanceSaveStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load auto attendance status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await saveAccountForAutoAttendance();
      if (!res.ok) {
        setError(res.error || 'Could not save this account on the device.');
        return;
      }
      const extra = res.warnings.filter(Boolean);
      setNote(
        extra.length
          ? `Saved on this device. ${extra.join(' ')}`
          : 'Saved on this device. Background check-in is on — you can close the app.',
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this account on the device.');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (
      !confirm(
        'Remove this device from auto attendance? Background check-in will stop until you save again.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await removeAccountFromAutoAttendance();
      if (!res.ok) {
        setError(res.error || 'Could not remove this device.');
      } else {
        setNote('Removed from this device. Background check-in is off.');
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove this device.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="auto-attend-save" style={{ display: 'flex', justifyContent: 'center', padding: '1.25rem' }}>
        <Loader2 className="spin-icon" size={22} />
      </div>
    );
  }

  if (!status) return null;

  if (status.kind === 'unsupported') {
    return (
      <div className="auto-attend-save">
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Background check-in (office Wi‑Fi or radius, without opening Scorr) is available in the{' '}
          <strong>Android app</strong> and <strong>desktop app</strong>. Open Settings there and choose
          Save account for auto attendance. iOS and the browser cannot stay enrolled in the background.
        </p>
        <p style={{ margin: '0.65rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          This client: {status.platformLabel}
        </p>
      </div>
    );
  }

  const saved = status.saved;
  const needsPerm =
    status.needsLocation ||
    status.needsBackgroundLocation ||
    status.needsNotifications ||
    status.needsBattery;

  return (
    <div className="auto-attend-save">
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        {status.optInText}
      </p>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem 0.85rem',
          alignItems: 'center',
          marginBottom: '0.85rem',
          fontSize: '0.85rem',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            fontWeight: 600,
            color: saved ? 'var(--color-success, #0f766e)' : 'var(--text-primary)',
          }}
        >
          {saved ? <CheckCircle2 size={16} /> : <ShieldOff size={16} />}
          {saved ? 'Saved on this device' : 'Not saved on this device'}
        </span>
        <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          <Smartphone size={14} /> {status.platformLabel}
        </span>
      </div>

      <ul
        style={{
          margin: '0 0 0.85rem',
          padding: '0 0 0 1.1rem',
          fontSize: '0.82rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.45,
        }}
      >
        <li style={{ marginBottom: '0.25rem' }}>
          <Wifi size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Office Wi‑Fi match checks you in first
        </li>
        <li>
          <MapPin size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Else office radius (location on)
        </li>
      </ul>

      {status.setupIssues.length > 0 && (
        <div
          style={{
            marginBottom: '0.85rem',
            padding: '0.65rem 0.75rem',
            borderRadius: 10,
            background: 'color-mix(in srgb, var(--color-warning, #b45309) 12%, transparent)',
            fontSize: '0.82rem',
            color: 'var(--text-primary)',
            lineHeight: 1.45,
          }}
        >
          <strong>Before auto check-in works</strong>
          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            {status.setupIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {status.permissionLines.length > 0 && (
        <div style={{ marginBottom: '0.85rem', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          <strong style={{ color: 'var(--text-primary)' }}>
            {needsPerm ? 'Permissions needed' : 'Permissions'}
          </strong>
          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            {status.permissionLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {status.batteryLines.length > 0 && (
            <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
              {status.batteryLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem', alignItems: 'center' }}>
        {!saved ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onSave()}>
            {busy ? <Loader2 size={16} className="spin-icon" /> : <Radio size={16} />}
            Save account on this device
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void onSave()}>
              {busy ? <Loader2 size={16} className="spin-icon" /> : <Radio size={16} />}
              Re-save / refresh
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void onRemove()}>
              Remove from this device
            </button>
          </>
        )}
        {status.kind === 'android' && (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void openNativeAppSettings()}
            >
              <Settings2 size={16} /> App settings
            </button>
            {status.needsBattery && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void openNativeBatterySettings()}
              >
                Battery settings
              </button>
            )}
          </>
        )}
      </div>

      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0.75rem 0 0' }}>{error}</p>
      )}
      {note && (
        <p style={{ color: 'var(--color-success, #0f766e)', fontSize: '0.85rem', margin: '0.75rem 0 0' }}>
          {note}
        </p>
      )}
    </div>
  );
}

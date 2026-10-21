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
import { friendlyAutoAttendanceError } from '../utils/attendanceDevice';
import { DESKTOP_LINUX_DEB_PATH, DESKTOP_WIN_PATH } from '../utils/appStoreLinks';
import DesktopWifiDiagnostics from './DesktopWifiDiagnostics';

type UiState = 'active' | 'needs_setup' | 'off';

function resolveUiState(status: AutoAttendanceSaveStatus): UiState {
  if (!status.saved) return 'off';
  if (status.backgroundArmed) {
    // Desktop: armed = Active (no phone permission gates). setupIssues are informational.
    if (status.kind === 'desktop') return 'active';
    const blocking =
      status.needsLocation ||
      status.needsBackgroundLocation ||
      status.needsNotifications ||
      status.needsBattery ||
      status.setupIssues.length > 0;
    return blocking ? 'needs_setup' : 'active';
  }
  return 'needs_setup';
}

function statusLabel(state: UiState): string {
  if (state === 'active') return 'Active';
  if (state === 'needs_setup') return 'Needs setup';
  return 'Off';
}

function statusDetail(state: UiState): string {
  if (state === 'active') return 'Automatic check-in is on';
  if (state === 'needs_setup') return 'Tap Enable automatic check-in to finish setup';
  return 'Automatic check-in is off on this device';
}

/** Force Off in the UI after Turn off so Enable is never stuck hidden. */
function asOffStatus(prev: AutoAttendanceSaveStatus): AutoAttendanceSaveStatus {
  return {
    ...prev,
    saved: false,
    backgroundArmed: false,
    setupIssues: [],
    needsLocation: false,
    needsBackgroundLocation: false,
    needsNotifications: false,
    needsBattery: false,
    batteryLines: [],
    windowHint: null,
    permissionLines:
      prev.kind === 'desktop'
        ? ['After you enable, this computer can check in while the app or tray icon is running.']
        : prev.kind === 'android'
          ? ['Tap Enable automatic check-in to register this phone again.']
          : prev.permissionLines,
  };
}

export default function AutoAttendanceSavePanel() {
  const [status, setStatus] = useState<AutoAttendanceSaveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [noteTone, setNoteTone] = useState<'success' | 'neutral'>('success');

  const refresh = useCallback(async (): Promise<AutoAttendanceSaveStatus | null> => {
    setLoading(true);
    try {
      const next = await getAutoAttendanceSaveStatus();
      setStatus(next);
      return next;
    } catch (e) {
      setError(friendlyAutoAttendanceError(e, 'Could not load automatic check-in status.'));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Electron injects window.scorrDesktop / shell marker slightly after first paint.
  // Re-check so we do not stay stuck on “Browser” inside the real desktop window.
  useEffect(() => {
    let cancelled = false;
    const again = () => {
      if (cancelled) return;
      const desk = typeof window !== 'undefined' ? window.scorrDesktop : undefined;
      const marked =
        typeof window !== 'undefined' &&
        Boolean(
          (window as Window & { __SCORR_ELECTRON_SHELL__?: boolean }).__SCORR_ELECTRON_SHELL__ ||
            document.documentElement?.dataset?.scorrDesktop,
        );
      if (desk?.isDesktop || marked) void refresh();
    };
    const ids = [300, 800, 1600, 3200].map((ms) => window.setTimeout(again, ms));
    return () => {
      cancelled = true;
      ids.forEach((id) => window.clearTimeout(id));
    };
  }, [refresh]);

  const onSave = async () => {
    setBusy(true);
    setError('');
    setNote('');
    setNoteTone('success');
    try {
      const res = await saveAccountForAutoAttendance();
      const next = await refresh();
      const reallyActive = next ? resolveUiState(next) === 'active' : false;
      const reallyArmed = Boolean(next?.backgroundArmed);

      if (!res.ok) {
        setError(
          friendlyAutoAttendanceError(res.error, 'Couldn’t enable automatic check-in. Try again.'),
        );
        return;
      }

      // Desktop: enrollment + main arm already validated in saveAccountForAutoAttendance.
      // Do not turn soft warnings into a red failure (that caused the false “not armed” loop).
      if (!reallyArmed && next?.kind !== 'desktop') {
        setError(
          res.warnings[0] ||
            'Setup did not finish on this phone. Allow location All the time, notifications, and Unrestricted battery, then tap Enable automatic check-in.',
        );
        return;
      }

      const extra = res.warnings.filter(Boolean);
      if (reallyActive || (next?.kind === 'desktop' && reallyArmed)) {
        setNoteTone('success');
        setNote(
          extra.length
            ? `Automatic check-in is on. ${extra.join(' ')}`
            : 'Automatic check-in is on — you can close the app.',
        );
      } else if (next?.kind === 'desktop' && !reallyArmed) {
        setError(
          res.error ||
            'Could not arm background check-in. Quit Scorr fully, open the installed app, then tap Enable.',
        );
      } else {
        // Armed but still needs a permission — show blocker, not green “updated”
        setError(
          extra.length
            ? extra.join(' ')
            : 'Automatic check-in is armed, but finish the permissions listed above.',
        );
      }
    } catch (e) {
      setError(friendlyAutoAttendanceError(e, 'Couldn’t enable automatic check-in. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (
      !confirm(
        'Turn off automatic check-in on this device? You can enable it again anytime.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await removeAccountFromAutoAttendance();
      // Always surface Off + Enable after local teardown (even if server RPC failed).
      if (res.locallyCleared) {
        setStatus((prev) => (prev ? asOffStatus(prev) : prev));
        setNoteTone('neutral');
        setNote(
          res.ok
            ? 'Automatic check-in is off on this device. Tap Enable automatic check-in to add it again.'
            : 'This device was cleared locally. Tap Enable automatic check-in to add it again.',
        );
      }
      if (!res.ok) {
        setError(friendlyAutoAttendanceError(res.error, 'Could not turn off on this device.'));
      }
      await refresh();
    } catch (e) {
      setStatus((prev) => (prev ? asOffStatus(prev) : prev));
      setNoteTone('neutral');
      setNote('This device was cleared locally. Tap Enable automatic check-in to add it again.');
      setError(friendlyAutoAttendanceError(e, 'Could not turn off on this device.'));
      await refresh();
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
    const isLinuxHint =
      typeof navigator !== 'undefined' && /linux/i.test(navigator.userAgent || '');
    const isWinHint =
      typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent || '');
    return (
      <div className="auto-attend-save">
        <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
          Automatic check-in
        </p>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          This window is the <strong>website</strong> (Chrome/Firefox or a Chrome “Install app”
          shortcut), not the Scorr Desktop program. About can show a version from the website —
          that does <strong>not</strong> mean the desktop binary is running. The window title must
          say <strong>Scorr Desktop</strong> with a version in the window title
          (Windows 1.3.40+ / Linux 1.3.39+).
        </p>
        <ol
          style={{
            margin: '0.65rem 0 0',
            paddingLeft: '1.2rem',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {isLinuxHint ? (
            <>
              <li>
                Download{' '}
                <a href={DESKTOP_LINUX_DEB_PATH} style={{ color: 'var(--accent, #0f766e)' }}>
                  Scorr.deb
                </a>{' '}
                (Linux v1.3.39+)
              </li>
              <li>
                Install: <code>sudo apt install ./Scorr.deb</code>
              </li>
              <li>
                Open <strong>Scorr</strong> from the Applications menu (search “Scorr”) — close
                Chrome/Firefox tabs for scorr.walfia.ai
              </li>
              <li>Sign in → Settings → Automatic check-in → Enable</li>
            </>
          ) : isWinHint ? (
            <>
              <li>
                Download{' '}
                <a href={DESKTOP_WIN_PATH} style={{ color: 'var(--accent, #0f766e)' }}>
                  Scorr-Setup.exe
                </a>
              </li>
              <li>Install, then open Scorr from the Start Menu (not Edge/Chrome)</li>
              <li>Sign in → Settings → Automatic check-in → Enable</li>
            </>
          ) : (
            <>
              <li>Install the Android, iOS, or desktop app from Downloads</li>
              <li>Open that app (not this browser tab) and enable Automatic check-in</li>
            </>
          )}
        </ol>
        <p style={{ margin: '0.65rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          This window: {status.platformLabel}
        </p>
      </div>
    );
  }

  const uiState = resolveUiState(status);
  const saved = status.saved;
  const showEnable = !saved || uiState === 'needs_setup';
  const needsPerm =
    status.needsLocation ||
    status.needsBackgroundLocation ||
    status.needsNotifications ||
    status.needsBattery ||
    (saved && !status.backgroundArmed);

  const statusColor =
    uiState === 'active'
      ? 'var(--color-success, #0f766e)'
      : uiState === 'needs_setup'
        ? 'var(--color-warning, #b45309)'
        : 'var(--text-primary)';

  return (
    <div className="auto-attend-save">
      <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
        Automatic check-in
      </p>
      <p style={{ margin: '0.35rem 0 0.85rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
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
            color: statusColor,
          }}
        >
          {uiState === 'active' ? <CheckCircle2 size={16} /> : <ShieldOff size={16} />}
          {statusLabel(uiState)}
          <span style={{ fontWeight: 500, opacity: 0.9 }}>— {statusDetail(uiState)}</span>
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
          Office Wi‑Fi checks you in first
        </li>
        <li style={{ marginBottom: '0.25rem' }}>
          <MapPin size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Otherwise, office area (with location on)
        </li>
        <li style={{ marginBottom: '0.25rem' }}>
          Runs from 1 hour before shift start until shift end
        </li>
        <li>
          Enable once — then auto works without opening the dashboard (app/tray must stay allowed to run)
        </li>
      </ul>

      {status.windowHint && uiState === 'active' && (
        <p
          style={{
            margin: '0 0 0.85rem',
            padding: '0.65rem 0.75rem',
            borderRadius: 10,
            background: 'color-mix(in srgb, var(--color-success, #0f766e) 10%, transparent)',
            fontSize: '0.82rem',
            color: 'var(--text-primary)',
            lineHeight: 1.45,
          }}
        >
          {status.windowHint}
        </p>
      )}

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
          <strong>Before automatic check-in works</strong>
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
            {needsPerm ? 'Finish setup' : 'Permissions'}
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
        {showEnable ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onSave()}>
            {busy ? <Loader2 size={16} className="spin-icon" /> : <Radio size={16} />}
            Enable automatic check-in
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void onSave()}>
            {busy ? <Loader2 size={16} className="spin-icon" /> : <Radio size={16} />}
            Refresh
          </button>
        )}
        {saved && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void onRemove()}>
            Turn off
          </button>
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

      {status.kind === 'desktop' && <DesktopWifiDiagnostics />}

      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0.75rem 0 0' }}>{error}</p>
      )}
      {note && (
        <p
          style={{
            color:
              noteTone === 'success'
                ? 'var(--color-success, #0f766e)'
                : 'var(--text-secondary)',
            fontSize: '0.85rem',
            margin: '0.75rem 0 0',
          }}
        >
          {note}
        </p>
      )}
    </div>
  );
}

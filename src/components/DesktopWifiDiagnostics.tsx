import { useCallback, useEffect, useState } from 'react';

type WifiSnap = {
  platform?: string;
  windowsVersion?: string;
  locationAllowed?: boolean | null;
  locationMessage?: string | null;
  ssid?: string | null;
  bssid?: string | null;
  publicIp?: string | null;
  matchesSaved?: boolean;
  statusLine?: string;
  logPath?: string;
  lastResult?: { action?: string | null; reason?: string | null; message?: string | null } | null;
};

function locationLabel(value: boolean | null | undefined): string {
  if (value === true) return 'allowed';
  if (value === false) return 'off';
  return 'unknown';
}

/** In-app Wi-Fi diagnostics for the desktop shell. No system notification. */
export default function DesktopWifiDiagnostics({ compact = false }: { compact?: boolean }) {
  const [snap, setSnap] = useState<WifiSnap | null>(null);
  const desk = typeof window !== 'undefined' ? window.scorrDesktop : undefined;
  const isWindows = desk?.platform === 'win32';

  const refresh = useCallback(async () => {
    if (typeof desk?.wifiDiagnostics !== 'function') return;
    try {
      const next = await desk.wifiDiagnostics();
      setSnap(next || null);
    } catch {
      /* shell not ready */
    }
  }, [desk]);

  useEffect(() => {
    if (!desk?.isDesktop) return;
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, 15000);
    return () => window.clearInterval(id);
  }, [desk?.isDesktop, refresh]);

  if (!desk?.isDesktop || !snap) return null;

  return (
    <section data-scorr-wifi-diagnostics="1" className="attendance-card" style={{ marginTop: compact ? 0 : '0.75rem' }}>
      {compact ? (
        <p className="attendance-present-banner" role="status" style={{ marginTop: 0 }}>
          {snap.statusLine || 'Automatic check-in status will appear here.'}
        </p>
      ) : (
        <>
          <h3 className="attendance-card__title">Wi-Fi diagnostics</h3>
          <p className="attendance-present-banner" role="status">{snap.statusLine}</p>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', fontSize: '0.82rem', lineHeight: 1.45 }}>
            {isWindows && <li>Windows: {snap.windowsVersion || 'unknown'}</li>}
            {isWindows && <li>Location: {locationLabel(snap.locationAllowed)}</li>}
            <li>SSID: {snap.ssid || '—'}</li>
            <li>BSSID: {snap.bssid || '—'}</li>
            <li>Public IP: {snap.publicIp || '—'}</li>
            <li>Matches a saved network: {snap.matchesSaved ? 'yes' : 'no'}</li>
            <li>Last result: {snap.lastResult?.reason || snap.lastResult?.action || '—'}</li>
            {snap.logPath && <li>Log file: {snap.logPath}</li>}
          </ul>
        </>
      )}
      {snap.locationMessage && (
        <div style={{ marginTop: '0.65rem' }}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>{snap.locationMessage}</p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '0.5rem' }}
            onClick={() => { void desk.openLocationSettings?.(); }}
          >
            Open Location settings
          </button>
        </div>
      )}
    </section>
  );
}

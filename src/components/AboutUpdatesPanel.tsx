import { useState } from 'react';
import { Info, Loader2, RefreshCw } from 'lucide-react';
import {
  applyNativeUpdate,
  hardRefreshWeb,
  localWebBuildId,
  packageVersion,
  type UpdateAction,
} from '../utils/appUpdate';
import { checkForUpdatesNow } from './AppUpdateBanner';
import { isAppShell, isDesktopApp, isNativeApp } from '../utils/nativePlatform';

export default function AboutUpdatesPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateAction | null>(null);
  const [msg, setMsg] = useState('');

  const onCheck = async () => {
    setBusy(true);
    setMsg('');
    try {
      const next = await checkForUpdatesNow();
      setResult(next);
      if (next.kind === 'none') {
        setMsg('You are on the latest version.');
        return;
      }
      setMsg('Updating…');
      if (next.kind === 'refresh') {
        hardRefreshWeb();
        return;
      }
      if (next.kind === 'native') {
        const applied = await applyNativeUpdate(next);
        setMsg(
          next.platform === 'android'
            ? 'Downloading update… Confirm Install when Android asks.'
            : applied || 'Updating…',
        );
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not check for updates.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="about-updates glass-panel">
      <div className="about-updates__head">
        <div className="about-updates__icon">
          <Info size={18} />
        </div>
        <div>
          <h3>About &amp; updates</h3>
          <p>Checks for updates daily around 5:00 AM and installs them automatically when available.</p>
        </div>
      </div>
      <dl className="about-updates__meta">
        <div>
          <dt>App version</dt>
          <dd>{packageVersion()}</dd>
        </div>
        <div>
          <dt>Web build</dt>
          <dd>{localWebBuildId() || '—'}</dd>
        </div>
        <div>
          <dt>Client</dt>
          <dd>
            {isNativeApp()
              ? 'Phone app'
              : isDesktopApp()
                ? 'Desktop app'
                : isAppShell()
                  ? 'Installed shell'
                  : 'Browser / Home Screen'}
          </dd>
        </div>
      </dl>
      <div className="about-updates__actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void onCheck()}>
          {busy ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
          Check for updates
        </button>
      </div>
      {msg && <p className="about-updates__msg">{msg}</p>}
      {result?.kind === 'native' && result.notes && <p className="about-updates__msg">{result.notes}</p>}
    </section>
  );
}

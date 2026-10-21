import { useEffect, useRef, useState } from 'react';
import { Info, Loader2, RefreshCw } from 'lucide-react';
import {
  applyNativeUpdate,
  hardRefreshWeb,
  localWebBuildId,
  packageVersion,
  type UpdateAction,
} from '../utils/appUpdate';
import { checkForUpdatesNow } from './AppUpdateBanner';
import {
  hasScorrDesktopApi,
  hasScorrDesktopBridge,
  hasScorrElectronShellMarker,
  isAppShell,
  isDesktopApp,
  isElectronShell,
  isNativeApp,
} from '../utils/nativePlatform';

/** Shell/UA present but saveAttendanceToken missing — reinstall, not “web is outdated”. */
function desktopBridgeMissingLabel(): string {
  const win =
    typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent || '');
  const pkg = win ? 'Scorr-Setup.exe' : 'Scorr.deb';
  return `Desktop app (bridge missing — quit Scorr including tray, reinstall ${pkg}, reopen)`;
}

function clientLabel(electronVersion: string | null): string {
  if (isNativeApp()) return 'Phone app';
  if (hasScorrDesktopBridge()) {
    return `Desktop app${electronVersion ? ` ${electronVersion}` : ''}`;
  }
  // Partial preload (e.g. ancient 1.3.4), shell marker, or UA without full bridge.
  if (hasScorrDesktopApi() || hasScorrElectronShellMarker() || isElectronShell()) {
    return desktopBridgeMissingLabel();
  }
  if (isAppShell()) {
    return 'Website / Chrome shortcut (not Scorr Desktop binary)';
  }
  return 'Browser';
}

function shellMarkerVersion(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const w = window as Window & { __SCORR_ELECTRON_VERSION__?: string };
    if (w.__SCORR_ELECTRON_VERSION__) return String(w.__SCORR_ELECTRON_VERSION__);
    const ds = document.documentElement?.dataset?.scorrDesktop;
    return ds ? String(ds) : null;
  } catch {
    return null;
  }
}

export default function AboutUpdatesPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateAction | null>(null);
  const [msg, setMsg] = useState('');
  const [electronVersion, setElectronVersion] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const readyUnsubRef = useRef<(() => void) | null>(null);
  /** When true, desktop download/install owns busy — do not clear in finally. */
  const desktopInstallInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const v = await Promise.resolve(window.scorrDesktop?.getAppVersion?.());
        if (!cancelled && v) setElectronVersion(String(v));
      } catch {
        /* bridge missing */
      }
      if (!cancelled) setTick((n) => n + 1);
    };
    void read();
    // Preload/marker can appear just after first paint — re-read briefly.
    const t1 = window.setTimeout(() => void read(), 400);
    const t2 = window.setTimeout(() => void read(), 1500);
    const t3 = window.setTimeout(() => void read(), 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      readyUnsubRef.current?.();
    };
  }, []);

  const attachDesktopStatusListeners = () => {
    readyUnsubRef.current?.();
    readyUnsubRef.current = null;

    if (window.scorrDesktop?.onUpdateReady) {
      readyUnsubRef.current = window.scorrDesktop.onUpdateReady(() => {
        desktopInstallInFlightRef.current = true;
        setBusy(true);
        setMsg('');
      });
    }
  };

  const onCheck = async () => {
    setBusy(true);
    desktopInstallInFlightRef.current = false;
    setMsg('');
    setResult(null);
    attachDesktopStatusListeners();

    try {
      // Desktop binary: electron-updater check → silent download → quitAndInstall.
      if (isDesktopApp() && hasScorrDesktopBridge() && window.scorrDesktop?.checkForUpdates) {
        const res = await window.scorrDesktop.checkForUpdates();

        if (res.updateAvailable && res.autoInstall !== false) {
          desktopInstallInFlightRef.current = true;
          setMsg('');
          void checkForUpdatesNow().then((next) => {
            if (next.kind === 'refresh') hardRefreshWeb();
          });
          return;
        }

        if (res.updateAvailable && res.autoInstall === false) {
          setMsg(res.message || '');
          return;
        }

        const next = await checkForUpdatesNow();
        setResult(next);
        if (next.kind === 'refresh') {
          setMsg('');
          hardRefreshWeb();
          return;
        }
        // Do not install from a website-vs-feed comparison. The shell emits
        // onUpdateReady, and the update banner restarts only for that event.
        setMsg(res.message || 'You are on the latest version.');
        return;
      }

      const next = await checkForUpdatesNow();
      setResult(next);
      if (next.kind === 'none') {
        if (!hasScorrDesktopBridge() && isElectronShell()) {
          setMsg(
            'Website UI is current, but this desktop binary cannot Enable auto check-in. Quit Scorr (tray too), reinstall the latest Setup.exe / .deb, then reopen.',
          );
          return;
        }
        if (isDesktopApp()) {
          setMsg('You are on the latest version.');
          return;
        }
        setMsg('You are on the latest version.');
        return;
      }
      setMsg('');
      if (next.kind === 'refresh') {
        hardRefreshWeb();
        return;
      }
      if (next.kind === 'native') {
        await applyNativeUpdate(next);
        if (
          (next.platform === 'windows' || next.platform === 'linux') &&
          next.canAutoInstall &&
          window.scorrDesktop?.checkForUpdates
        ) {
          desktopInstallInFlightRef.current = true;
        }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not check for updates.');
      desktopInstallInFlightRef.current = false;
    } finally {
      if (!desktopInstallInFlightRef.current) setBusy(false);
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
          <p>
            Checks for updates daily around 5:00 AM. Tap Check for updates anytime to download and
            download and install quietly in the background (no banner).
          </p>
        </div>
      </div>
      <dl className="about-updates__meta">
        <div>
          <dt>App version</dt>
          <dd>
            {electronVersion
              ? electronVersion
              : shellMarkerVersion()
                ? `${shellMarkerVersion()} (shell marker — bridge incomplete)`
                : isElectronShell()
                  ? `${packageVersion()} (website UI — desktop bridge not detected)`
                  : `${packageVersion()} (website UI — desktop binary not detected)`}
          </dd>
        </div>
        <div>
          <dt>Web build</dt>
          <dd>{localWebBuildId() || '—'}</dd>
        </div>
        <div>
          <dt>Client</dt>
          <dd>{clientLabel(electronVersion)}</dd>
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

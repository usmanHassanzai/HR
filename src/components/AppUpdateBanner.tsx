import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import {
  applyNativeUpdate,
  dismissUpdate,
  evaluateUpdate,
  hardRefreshWeb,
  isUpdateDismissed,
  markUpdateChecked,
  shouldRunPeriodicCheck,
  type UpdateAction,
} from '../utils/appUpdate';
import { isDesktopApp } from '../utils/nativePlatform';

const DAILY_MS = 24 * 60 * 60 * 1000;
const DESKTOP_MS = 6 * 60 * 60 * 1000;

export default function AppUpdateBanner({ forceCheck = false }: { forceCheck?: boolean }) {
  const [action, setAction] = useState<UpdateAction>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const runCheck = useCallback(async (forced = false) => {
    const interval = isDesktopApp() ? DESKTOP_MS : DAILY_MS;
    if (!forced && !shouldRunPeriodicCheck(interval) && !forceCheck) return;
    const next = await evaluateUpdate();
    markUpdateChecked();
    if (next.kind === 'none') {
      setAction(next);
      return;
    }
    const key =
      next.kind === 'refresh'
        ? `refresh:${next.remoteBuildId}`
        : `native:${next.platform}:${next.version}`;
    if (!next.mandatory && isUpdateDismissed(key) && !forced) return;
    setAction(next);
  }, [forceCheck]);

  useEffect(() => {
    void runCheck(forceCheck);
    const onVis = () => {
      if (document.visibilityState === 'visible') void runCheck(false);
    };
    document.addEventListener('visibilitychange', onVis);
    let unsub: (() => void) | undefined;
    if (isDesktopApp() && window.scorrDesktop?.onUpdateReady) {
      unsub = window.scorrDesktop.onUpdateReady((payload) => {
        setAction({
          kind: 'native',
          platform: navigator.userAgent.toLowerCase().includes('windows') ? 'windows' : 'linux',
          message: 'Restart to update',
          notes: payload?.message || `Version ${payload?.version || ''} is ready.`,
          mandatory: false,
          version: payload?.version || '',
          installUrl: '',
          canAutoInstall: true,
        });
        setNote('Update downloaded. Restart Scorr to finish.');
      });
    }
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      unsub?.();
    };
  }, [forceCheck, runCheck]);

  if (action.kind === 'none') return null;

  const mandatory = action.mandatory;
  const dismissKey =
    action.kind === 'refresh'
      ? `refresh:${action.remoteBuildId}`
      : `native:${action.platform}:${action.version}`;

  return (
    <div
      className={`app-update-banner${mandatory ? ' app-update-banner--mandatory' : ''}`}
      role="status"
    >
      <div className="app-update-banner__body">
        <strong>{action.message}</strong>
        {action.kind === 'native' && action.notes ? (
          <span className="app-update-banner__notes">{action.notes}</span>
        ) : (
          <span className="app-update-banner__notes">
            {action.kind === 'refresh'
              ? 'A newer web build is live. Refresh to load it — your login stays signed in.'
              : null}
          </span>
        )}
        {note && <span className="app-update-banner__notes">{note}</span>}
      </div>
      <div className="app-update-banner__actions">
        {action.kind === 'refresh' && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => hardRefreshWeb()}>
            <RefreshCw size={14} /> Refresh
          </button>
        )}
        {action.kind === 'native' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              if (action.message === 'Restart to update' && window.scorrDesktop?.quitAndInstall) {
                void Promise.resolve(window.scorrDesktop.quitAndInstall()).finally(() => setBusy(false));
                return;
              }
              void applyNativeUpdate(action)
                .then((msg) => setNote(msg))
                .finally(() => setBusy(false));
            }}
          >
            <Download size={14} />{' '}
            {busy
              ? 'Working…'
              : action.message === 'Restart to update'
                ? 'Restart to update'
                : action.platform === 'linux' && !action.canAutoInstall
                  ? 'Download'
                  : 'Install update'}
          </button>
        )}
        {!mandatory && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label="Dismiss"
            onClick={() => {
              dismissUpdate(dismissKey);
              setAction({ kind: 'none' });
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Imperative check used by Settings → About. */
export async function checkForUpdatesNow(): Promise<UpdateAction> {
  const next = await evaluateUpdate();
  markUpdateChecked();
  return next;
}

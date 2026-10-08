import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyNativeUpdate,
  DAILY_UPDATE_HOUR,
  evaluateUpdate,
  hardRefreshWeb,
  markUpdateChecked,
  msUntilNextDailyUpdateCheck,
  shouldRunDailyUpdateCheck,
  type UpdateAction,
} from '../utils/appUpdate';
import { isDesktopApp } from '../utils/nativePlatform';

const AUTO_APPLIED_KEY = 'scorr-auto-applied-update';

function actionKey(next: UpdateAction): string {
  if (next.kind === 'refresh') return `refresh:${next.remoteBuildId}`;
  if (next.kind === 'native') return `native:${next.platform}:${next.version}`;
  return 'none';
}

function alreadyAutoApplied(key: string): boolean {
  try {
    return sessionStorage.getItem(AUTO_APPLIED_KEY) === key;
  } catch {
    return false;
  }
}

function markAutoApplied(key: string) {
  try {
    sessionStorage.setItem(AUTO_APPLIED_KEY, key);
  } catch {
    /* ignore */
  }
}

export default function AppUpdateBanner({ forceCheck = false }: { forceCheck?: boolean }) {
  const [action, setAction] = useState<UpdateAction>({ kind: 'none' });
  const [note, setNote] = useState('');
  const applyingRef = useRef(false);
  const desktopInstallStartedRef = useRef(false);

  const autoApply = useCallback(async (next: UpdateAction) => {
    if (next.kind === 'none') return;

    const key = actionKey(next);
    const desktopInstallReady =
      next.kind === 'native' &&
      (next.platform === 'windows' || next.platform === 'linux') &&
      (next.message === 'Updating…' || next.message === 'Restart to update');

    if (desktopInstallReady) {
      if (desktopInstallStartedRef.current) return;
      desktopInstallStartedRef.current = true;
      applyingRef.current = true;
      setAction(next);
      setNote('Updating…');
      if (window.scorrDesktop?.quitAndInstall) {
        window.setTimeout(() => {
          void Promise.resolve(window.scorrDesktop?.quitAndInstall?.()).catch(() => {
            desktopInstallStartedRef.current = false;
            applyingRef.current = false;
            setNote('Update ready — will install when Scorr quits.');
          });
        }, 400);
      }
      return;
    }

    if (applyingRef.current || alreadyAutoApplied(key)) return;
    applyingRef.current = true;
    markAutoApplied(key);
    setAction(next);
    setNote('Updating…');

    if (next.kind === 'refresh') {
      window.setTimeout(() => hardRefreshWeb(), 500);
      return;
    }

    if (next.kind === 'native') {
      try {
        const msg = await applyNativeUpdate(next);
        setNote(
          next.platform === 'android'
            ? 'Downloading update… Confirm Install when Android asks.'
            : msg || 'Updating…',
        );
      } catch (e) {
        setNote(e instanceof Error ? e.message : 'Update failed.');
        applyingRef.current = false;
      }
    }
  }, []);

  const runCheck = useCallback(
    async (forced = false) => {
      if (!forced && !shouldRunDailyUpdateCheck(DAILY_UPDATE_HOUR) && !forceCheck) return;
      const next = await evaluateUpdate();
      markUpdateChecked();
      if (next.kind === 'none') {
        setAction(next);
        return;
      }
      void autoApply(next);
    },
    [autoApply, forceCheck],
  );

  useEffect(() => {
    // Catch-up: if we missed today's 5 AM window (app was closed), check now.
    if (forceCheck || shouldRunDailyUpdateCheck(DAILY_UPDATE_HOUR)) {
      void runCheck(true);
    }

    let dailyTimer: number | null = null;
    const armDailyTimer = () => {
      if (dailyTimer != null) window.clearTimeout(dailyTimer);
      dailyTimer = window.setTimeout(() => {
        void runCheck(true).finally(() => armDailyTimer());
      }, msUntilNextDailyUpdateCheck(DAILY_UPDATE_HOUR));
    };
    armDailyTimer();

    // When the laptop wakes, run if the 5 AM window is due.
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      if (!shouldRunDailyUpdateCheck(DAILY_UPDATE_HOUR)) return;
      void runCheck(true);
    };
    document.addEventListener('visibilitychange', onVis);

    let unsub: (() => void) | undefined;
    if (isDesktopApp() && window.scorrDesktop?.onUpdateReady) {
      unsub = window.scorrDesktop.onUpdateReady((payload) => {
        void autoApply({
          kind: 'native',
          platform: navigator.userAgent.toLowerCase().includes('windows') ? 'windows' : 'linux',
          message: 'Updating…',
          notes: payload?.message || `Version ${payload?.version || ''} is ready.`,
          mandatory: true,
          version: payload?.version || '',
          installUrl: '',
          canAutoInstall: true,
        });
      });
    }
    return () => {
      if (dailyTimer != null) window.clearTimeout(dailyTimer);
      document.removeEventListener('visibilitychange', onVis);
      unsub?.();
    };
  }, [autoApply, forceCheck, runCheck]);

  if (action.kind === 'none') return null;

  return (
    <div className="app-update-banner app-update-banner--applying" role="status" aria-live="polite">
      <div className="app-update-banner__body">
        <strong>Updating…</strong>
        <span className="app-update-banner__notes">
          {note ||
            (action.kind === 'refresh'
              ? 'Loading the latest web build. Your login stays signed in.'
              : action.kind === 'native' && action.platform === 'android'
                ? 'Preparing the APK. Android may ask you to confirm Install once.'
                : 'Installing in the background. Login and attendance stay intact.')}
        </span>
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

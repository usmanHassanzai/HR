import { useCallback, useEffect, useRef } from 'react';
import {
  applyNativeUpdate,
  DAILY_UPDATE_HOUR,
  evaluateUpdate,
  hardRefreshWeb,
  markUpdateChecked,
  msUntilNextDailyUpdateCheck,
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

/**
 * Headless updater — downloads/installs in the background with no on-screen banner.
 * Android may still show the system Install sheet (OS requirement for sideloaded APKs).
 * Desktop restarts only when the shell emits onUpdateReady. Web hard-refreshes silently.
 */
export default function AppUpdateBanner({ forceCheck = false }: { forceCheck?: boolean }) {
  const applyingRef = useRef(false);
  const desktopInstallStartedRef = useRef(false);

  const autoApply = useCallback(async (next: UpdateAction) => {
    if (next.kind === 'none') return;

    const key = actionKey(next);
    const desktopInstallReady =
      next.kind === 'native' &&
      (next.platform === 'windows' || next.platform === 'linux') &&
      next.message === 'Updating…';

    if (desktopInstallReady) {
      if (desktopInstallStartedRef.current) return;
      desktopInstallStartedRef.current = true;
      applyingRef.current = true;
      if (window.scorrDesktop?.quitAndInstall) {
        window.setTimeout(() => {
          void Promise.resolve(window.scorrDesktop?.quitAndInstall?.()).catch(() => {
            desktopInstallStartedRef.current = false;
            applyingRef.current = false;
          });
        }, 400);
      }
      return;
    }

    if (applyingRef.current || alreadyAutoApplied(key)) return;
    applyingRef.current = true;
    markAutoApplied(key);

    if (next.kind === 'refresh') {
      window.setTimeout(() => hardRefreshWeb(), 300);
      return;
    }

    if (next.kind === 'native') {
      try {
        await applyNativeUpdate(next);
      } catch {
        applyingRef.current = false;
      }
    }
  }, []);

  const runCheck = useCallback(
    async (forced = false) => {
      if (!forced && !forceCheck) return;
      const next = await evaluateUpdate();
      markUpdateChecked();
      if (next.kind === 'none') return;
      void autoApply(next);
    },
    [autoApply, forceCheck],
  );

  useEffect(() => {
    void runCheck(true);

    let dailyTimer: number | null = null;
    const armDailyTimer = () => {
      if (dailyTimer != null) window.clearTimeout(dailyTimer);
      dailyTimer = window.setTimeout(() => {
        void runCheck(true).finally(() => armDailyTimer());
      }, msUntilNextDailyUpdateCheck(DAILY_UPDATE_HOUR));
    };
    armDailyTimer();

    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      void runCheck(true);
    };
    document.addEventListener('visibilitychange', onVis);

    let unsubReady: (() => void) | undefined;
    if (isDesktopApp() && window.scorrDesktop?.onUpdateReady) {
      unsubReady = window.scorrDesktop.onUpdateReady((payload) => {
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
    // Intentionally ignore onUpdateStatus — no in-app progress banner.
    return () => {
      if (dailyTimer != null) window.clearTimeout(dailyTimer);
      document.removeEventListener('visibilitychange', onVis);
      unsubReady?.();
    };
  }, [autoApply, forceCheck, runCheck]);

  return null;
}

/** Imperative check used by Settings → About. */
export async function checkForUpdatesNow(): Promise<UpdateAction> {
  const next = await evaluateUpdate();
  markUpdateChecked();
  return next;
}

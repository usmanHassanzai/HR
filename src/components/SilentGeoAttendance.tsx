import { useEffect } from 'react';
import {
  refreshNativeAttendanceSession,
  startNativeAttendancePings,
} from '../utils/attendanceNativePing';
import {
  getAttendanceDeviceToken,
  sendAutoAttendanceEventWithLocation,
} from '../utils/attendanceDevice';
import { isAndroidApp, isDesktopApp, isIosApp } from '../utils/nativePlatform';

/**
 * Arms Wi-Fi / radius auto check-in after enrollment.
 * Android: native FGS / schedule. iOS: region monitoring. Desktop: Electron heartbeat.
 */
export default function SilentGeoAttendance() {
  useEffect(() => {
    if (!isAndroidApp() && !isIosApp() && !isDesktopApp()) return;
    let cancelled = false;
    let desktopTimer: number | undefined;

    const arm = async () => {
      try {
        const token = await getAttendanceDeviceToken();
        if (cancelled || !token) return;
        if (isAndroidApp() || isIosApp()) {
          await startNativeAttendancePings();
          await refreshNativeAttendanceSession();
        }
        if (isDesktopApp()) {
          // Re-push token into main (Linux keyring can drop decrypt after reboot)
          // so tray heartbeats stay armed, then nudge a check-in while UI is open.
          try {
            const desk = (
              window as Window & {
                scorrDesktop?: {
                  saveAttendanceToken?: (t: string) => Promise<boolean> | boolean | void;
                  prepareAutoAttendance?: () => Promise<unknown>;
                };
              }
            ).scorrDesktop;
            if (desk?.saveAttendanceToken) await Promise.resolve(desk.saveAttendanceToken(token));
            if (desk?.prepareAutoAttendance) await Promise.resolve(desk.prepareAutoAttendance());
          } catch {
            /* main bridge optional */
          }
          await sendAutoAttendanceEventWithLocation('ping');
        }
      } catch {
        /* plugin / network — retry on next visibility/online */
      }
    };

    void arm();
    if (isDesktopApp()) {
      desktopTimer = window.setInterval(() => {
        void arm();
      }, 5 * 60 * 1000);
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') void arm();
    };
    const onOnline = () => {
      void arm();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      if (desktopTimer) window.clearInterval(desktopTimer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return null;
}

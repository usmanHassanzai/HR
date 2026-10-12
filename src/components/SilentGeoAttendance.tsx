import { useEffect } from 'react';
import {
  refreshNativeAttendanceSession,
  startNativeAttendancePings,
} from '../utils/attendanceNativePing';
import {
  getAttendanceDeviceToken,
  sendAutoAttendanceEventWithLocation,
} from '../utils/attendanceDevice';
import { isAndroidApp, isDesktopApp } from '../utils/nativePlatform';

/**
 * Arms Wi-Fi / radius auto check-in after enrollment.
 * Android: native FGS / schedule. Desktop: renderer ping with GPS (Electron main also heartbeats).
 * iOS: explicitly left off.
 */
export default function SilentGeoAttendance() {
  useEffect(() => {
    if (!isAndroidApp() && !isDesktopApp()) return;
    let cancelled = false;
    let desktopTimer: number | undefined;

    const arm = async () => {
      try {
        const token = await getAttendanceDeviceToken();
        if (cancelled || !token) return;
        if (isAndroidApp()) {
          await startNativeAttendancePings();
          await refreshNativeAttendanceSession();
        }
        if (isDesktopApp()) {
          // Desktop Electron main process owns background heartbeats; this nudges
          // a check-in with GPS while the window is open (Wi-Fi probed in main).
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

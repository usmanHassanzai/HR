import { useEffect } from 'react';
import {
  refreshNativeAttendanceSession,
  startNativeAttendancePings,
} from '../utils/attendanceNativePing';
import { startIosHomeAttendance } from '../utils/attendanceIosHome';
import { getAttendanceDeviceToken, sendAutoAttendanceEventWithLocation } from '../utils/attendanceDevice';
import { isDesktopApp, isIosHomeScreen, isNativeApp } from '../utils/nativePlatform';

/**
 * Keeps native automatic attendance armed after dashboard logout when a
 * non-expiring device token is enrolled (N2). No JWT geo-hold required.
 */
export default function SilentGeoAttendance() {
  useEffect(() => {
    if (!isNativeApp() && !isIosHomeScreen() && !isDesktopApp()) return;
    let cancelled = false;
    let desktopTimer: number | undefined;

    const arm = async () => {
      const token = await getAttendanceDeviceToken();
      if (cancelled || !token) return;
      if (isNativeApp()) {
        await startNativeAttendancePings();
        await refreshNativeAttendanceSession();
      }
      if (isIosHomeScreen()) await startIosHomeAttendance();
      if (isDesktopApp()) await sendAutoAttendanceEventWithLocation('ping');
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

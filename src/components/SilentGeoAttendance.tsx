import { useEffect } from 'react';
import {
  refreshNativeAttendanceSession,
  startNativeAttendancePings,
} from '../utils/attendanceNativePing';
import { getAttendanceDeviceToken } from '../utils/attendanceDevice';
import { isNativeApp } from '../utils/nativePlatform';

/**
 * Keeps native automatic attendance armed after dashboard logout when a
 * non-expiring device token is enrolled (N2). No JWT geo-hold required.
 */
export default function SilentGeoAttendance() {
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;

    const arm = async () => {
      const token = await getAttendanceDeviceToken();
      if (cancelled || !token) return;
      await startNativeAttendancePings();
      await refreshNativeAttendanceSession();
    };

    void arm();
    const onVis = () => {
      if (document.visibilityState === 'visible') void arm();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return null;
}

import { useEffect, useRef } from 'react';
import { Profile } from '../utils/kpiHelpers';
import { usesOfficeGps } from '../utils/workModeHelpers';
import {
  refreshNativeAttendanceSession,
  startNativeAttendancePings,
} from '../utils/attendanceNativePing';
import { startIosHomeAttendance } from '../utils/attendanceIosHome';
import { isIosHomeScreen } from '../utils/nativePlatform';
import {
  AUTO_LOCATION_CHECK_MS,
  GEO_DASHBOARD_OPEN_EVENT,
  bootstrapAttendanceLocation,
  clearAttendanceWatch,
  submitGeoAutoPing,
  watchAttendancePosition,
  type AttendanceWatchId,
} from '../utils/geoAttendance';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

/**
 * Auto geofence attendance for office/hybrid staff (priority over manual buttons):
 * - Native apps: CL region monitoring / Android geofence via device token (no daily login)
 * - Web / foreground: ping while the portal session is active (including geo-hold)
 * Manual Clock in / Clock out remain in GeoAttendancePanel as override only.
 */
export default function GeoAttendanceTracker({ profile, onUpdate }: GeoAttendanceTrackerProps) {
  const isEligible =
    (profile.role === 'employee' || profile.role === 'manager' || profile.role === 'hr') &&
    usesOfficeGps(profile.work_mode);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!isEligible) {
      // Do not call stopAutoAttendance — that clears the Keychain token (R32).
      // Ineligible roles simply never start monitoring.
      return;
    }

    void startNativeAttendancePings();
    void startIosHomeAttendance();

    let cancelled = false;
    let watchId: AttendanceWatchId | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let lastPingAt = 0;
    let inFlight = false;

    const ping = async (force = false) => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === 'hidden' && !force && !isIosHomeScreen()) return;
      const minGap = Math.max(45_000, Math.floor(AUTO_LOCATION_CHECK_MS * 0.75));
      if (!force && Date.now() - lastPingAt < minGap) return;
      inFlight = true;
      try {
        await submitGeoAutoPing();
        lastPingAt = Date.now();
        onUpdateRef.current?.();
      } catch {
        /* Transient GPS / network errors — next interval retries */
      } finally {
        inFlight = false;
      }
    };

    void (async () => {
      try {
        await bootstrapAttendanceLocation();
      } catch {
        /* Permission will be asked again on the next ping / manual clock */
      }
      if (cancelled) return;
      await ping(true);

      try {
        watchId = await watchAttendancePosition(() => {
          void ping(false);
        });
      } catch {
        /* Interval + native service cover this */
      }
    })();

    intervalId = setInterval(() => {
      void ping(false);
    }, AUTO_LOCATION_CHECK_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshNativeAttendanceSession();
        void ping(true);
      }
    };
    const onDashboardOpen = () => {
      void refreshNativeAttendanceSession();
      void ping(true);
    };

    const onOnline = () => {
      void refreshNativeAttendanceSession();
      void ping(true);
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(GEO_DASHBOARD_OPEN_EVENT, onDashboardOpen);
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(GEO_DASHBOARD_OPEN_EVENT, onDashboardOpen);
      window.removeEventListener('online', onOnline);
      if (intervalId) clearInterval(intervalId);
      void clearAttendanceWatch(watchId);
      // Do not stop native pings here — they must keep running with the app closed.
    };
  }, [isEligible, profile.id]);

  return null;
}

export { geoActionLabel } from '../utils/geoAttendance';

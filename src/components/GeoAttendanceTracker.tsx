import { useEffect } from 'react';
import { Profile } from '../utils/kpiHelpers';
import { usesOfficeGps } from '../utils/workModeHelpers';
import { stopNativeAttendancePings } from '../utils/attendanceNativePing';
import { clearGeoHold } from '../utils/attendanceBackgroundSession';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

/**
 * No background GPS. Stops any leftover native interval service from older app builds.
 * Location is captured only when the person taps Clock in or Clock out.
 */
export default function GeoAttendanceTracker({ profile }: GeoAttendanceTrackerProps) {
  const isEligible =
    (profile.role === 'employee' || profile.role === 'manager') &&
    usesOfficeGps(profile.work_mode);

  useEffect(() => {
    clearGeoHold();
    void stopNativeAttendancePings();
  }, [isEligible]);

  return null;
}

export { geoActionLabel } from '../utils/geoAttendance';

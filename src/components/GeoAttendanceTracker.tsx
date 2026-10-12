import { Profile } from '../utils/kpiHelpers';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

/**
 * Automatic geofence / dashboard pings paused while rules are rebuilt.
 * Manual Clock in / Clock out remain on GeoAttendancePanel (show paused message).
 */
export default function GeoAttendanceTracker(_props: GeoAttendanceTrackerProps) {
  return null;
}

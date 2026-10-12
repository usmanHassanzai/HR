import { Profile } from '../utils/kpiHelpers';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

/**
 * Dashboard auto GPS pings stay off; Android/desktop background auto owns that path.
 * Manual Clock in / Clock out: GeoAttendancePanel (office Wi-Fi then radius).
 */
export default function GeoAttendanceTracker(_props: GeoAttendanceTrackerProps) {
  return null;
}

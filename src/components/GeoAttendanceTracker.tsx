import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  GeoPingResult,
  geoActionLabel,
  isGeoAttendanceEnabled,
  setGeoAttendanceEnabled,
} from '../utils/geoAttendance';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

const POLL_MS = 45000;

/** Background geofence watcher — runs while app is open for employees/managers. */
export default function GeoAttendanceTracker({ profile, onUpdate }: GeoAttendanceTrackerProps) {
  const [enabled, setEnabled] = useState(() => isGeoAttendanceEnabled());
  const watchId = useRef<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const sync = () => setEnabled(isGeoAttendanceEnabled());
    window.addEventListener('scorr-geo-toggle', sync);
    return () => window.removeEventListener('scorr-geo-toggle', sync);
  }, []);

  const isEligible = profile.role === 'employee' || profile.role === 'manager';

  const sendPing = useCallback(async (lat: number, lng: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { data, error: rpcError } = await supabase.rpc('process_geo_attendance_ping', {
        p_latitude: lat,
        p_longitude: lng,
      });
      if (rpcError) throw rpcError;
      const result = data as GeoPingResult;
      if (result.action === 'clock_in' || result.action === 'clock_out') {
        onUpdate?.();
      }
    } catch {
      // Silent background sync — panel shows errors to the user
    } finally {
      busy.current = false;
    }
  }, [onUpdate]);

  useEffect(() => {
    if (!isEligible || !enabled || !navigator.geolocation) return;

    const onPosition = (pos: GeolocationPosition) => {
      sendPing(pos.coords.latitude, pos.coords.longitude);
    };

    const onError = () => {
      // Permission errors are surfaced in GeoAttendancePanel
    };

    watchId.current = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: POLL_MS,
      timeout: 25000,
    });

    const interval = window.setInterval(() => {
      navigator.geolocation.getCurrentPosition(onPosition, () => {}, {
        enableHighAccuracy: true,
        maximumAge: POLL_MS,
        timeout: 20000,
      });
    }, POLL_MS);

    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      window.clearInterval(interval);
    };
  }, [isEligible, enabled, sendPing]);

  if (!isEligible) return null;

  return null;
}

export function useGeoAttendanceToggle() {
  const [enabled, setEnabledState] = useState(isGeoAttendanceEnabled);

  const toggle = (value: boolean) => {
    setGeoAttendanceEnabled(value);
    setEnabledState(value);
  };

  return { enabled, setEnabled: toggle };
}

export { geoActionLabel };

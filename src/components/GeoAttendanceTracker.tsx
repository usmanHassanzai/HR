import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  GeoPingResult,
  geoActionLabel,
  isGeoAttendanceEnabled,
  requestCurrentPosition,
  setGeoAttendanceEnabled,
} from '../utils/geoAttendance';
import { isNativeApp } from '../utils/nativePlatform';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

/** Background geofence sync — light polling only when user enabled GPS attendance. */
const POLL_MS_NATIVE = 90000;
const POLL_MS_WEB = 60000;

export default function GeoAttendanceTracker({ profile, onUpdate }: GeoAttendanceTrackerProps) {
  const [enabled, setEnabled] = useState(() => isGeoAttendanceEnabled());
  const [appActive, setAppActive] = useState(true);
  const busy = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const sync = () => setEnabled(isGeoAttendanceEnabled());
    window.addEventListener('scorr-geo-toggle', sync);
    return () => window.removeEventListener('scorr-geo-toggle', sync);
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => {
      setAppActive(isActive);
    });
    return () => {
      void sub.then((h) => h.remove());
    };
  }, []);

  const isEligible = profile.role === 'employee' || profile.role === 'manager';

  const sendPing = useCallback(async () => {
    if (busy.current || !appActive) return;
    busy.current = true;
    try {
      const pos = await requestCurrentPosition();
      const { data, error: rpcError } = await supabase.rpc('process_geo_attendance_ping', {
        p_latitude: pos.coords.latitude,
        p_longitude: pos.coords.longitude,
        p_accuracy: pos.coords.accuracy ?? null,
      });
      if (rpcError) throw rpcError;
      const result = data as GeoPingResult;
      if (result.action === 'clock_in' || result.action === 'clock_out') {
        onUpdate?.();
      }
    } catch {
      // Errors shown in GeoAttendancePanel
    } finally {
      busy.current = false;
    }
  }, [appActive, onUpdate]);

  useEffect(() => {
    if (!isEligible || !enabled || !appActive) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const pollMs = isNativeApp() ? POLL_MS_NATIVE : POLL_MS_WEB;
    void sendPing();
    timerRef.current = window.setInterval(() => void sendPing(), pollMs);

    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isEligible, enabled, appActive, sendPing]);

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

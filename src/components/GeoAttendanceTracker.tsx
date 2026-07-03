import { useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  GeoPingResult,
  ensureBackgroundLocationReady,
  isGeoAttendanceEnabled,
  requestCurrentPosition,
  setGeoAttendanceEnabled,
} from '../utils/geoAttendance';
import { isNativeApp } from '../utils/nativePlatform';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

const POLL_MS_FOREGROUND = 60000;
const POLL_MS_BACKGROUND = 120000;

function isClockEvent(action: GeoPingResult['action']): boolean {
  return action === 'clock_in' || action === 'clock_out' || action === 'clock_out_shift_end';
}

export default function GeoAttendanceTracker({ profile, onUpdate }: GeoAttendanceTrackerProps) {
  const [enabled, setEnabled] = useState(() => isGeoAttendanceEnabled());
  const [appActive, setAppActive] = useState(true);
  const busy = useRef(false);
  const timerRef = useRef<number | null>(null);
  const watchIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (!isEligible || !enabled) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (watchIdRef.current) {
        void Geolocation.clearWatch({ id: watchIdRef.current });
        watchIdRef.current = null;
      }
      return;
    }

    const pollMs = isNativeApp() && !appActive ? POLL_MS_BACKGROUND : POLL_MS_FOREGROUND;

    const ping = async (lat: number, lng: number, accuracy: number | null) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const { data, error: rpcError } = await supabase.rpc('process_geo_attendance_ping', {
          p_latitude: lat,
          p_longitude: lng,
          p_accuracy: accuracy,
        });
        if (rpcError) return;
        const result = data as GeoPingResult;
        if (isClockEvent(result.action)) onUpdate?.();
      } finally {
        busy.current = false;
      }
    };

    const runPing = async () => {
      try {
        const pos = await requestCurrentPosition();
        await ping(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      } catch {
        // silent — GeoAttendancePanel shows manual errors
      }
    };

    void (async () => {
      if (isNativeApp()) {
        try {
          await ensureBackgroundLocationReady();
        } catch {
          // user may fix permissions from panel
        }
      }
      await runPing();
    })();

    timerRef.current = window.setInterval(() => void runPing(), pollMs);

    if (isNativeApp()) {
      void Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 30000 },
        (pos, err) => {
          if (err || !pos) return;
          void ping(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
        },
      ).then((id) => {
        watchIdRef.current = id;
      });
    }

    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (watchIdRef.current) {
        void Geolocation.clearWatch({ id: watchIdRef.current });
        watchIdRef.current = null;
      }
    };
  }, [isEligible, enabled, appActive, onUpdate]);

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

export { geoActionLabel } from '../utils/geoAttendance';

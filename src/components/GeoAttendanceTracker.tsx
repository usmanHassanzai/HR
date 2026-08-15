import { useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  GeoPingResult,
  bootstrapAttendanceLocation,
  ensureBackgroundLocationReady,
  requestCurrentPosition,
} from '../utils/geoAttendance';
import { isNativeApp } from '../utils/nativePlatform';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

const POLL_MS_FOREGROUND = 30000;
const POLL_MS_BACKGROUND = 60000;

function isClockEvent(action: GeoPingResult['action']): boolean {
  return action === 'clock_in' || action === 'clock_out' || action === 'clock_out_shift_end';
}

export default function GeoAttendanceTracker({ profile, onUpdate }: GeoAttendanceTrackerProps) {
  const [appActive, setAppActive] = useState(true);
  const busy = useRef(false);
  const timerRef = useRef<number | null>(null);
  const watchIdRef = useRef<string | null>(null);
  const browserWatchRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => {
      setAppActive(isActive);
    });
    return () => {
      void sub.then((h) => h.remove());
    };
  }, []);

  const isEligible = profile.role === 'employee' || profile.role === 'manager' || profile.role === 'admin';

  useEffect(() => {
    if (!isEligible) return;

    const pollMs = isNativeApp() && !appActive ? POLL_MS_BACKGROUND : POLL_MS_FOREGROUND;

    const ping = async (lat: number, lng: number, accuracy: number | null) => {
      if (profile.role === 'admin') return; // admins get location warm-up only
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
        if (isClockEvent(result.action)) {
          window.dispatchEvent(new CustomEvent('scorr-geo-clock', { detail: result }));
          onUpdate?.();
        }
      } finally {
        busy.current = false;
      }
    };

    const runPing = async () => {
      try {
        const pos = await requestCurrentPosition();
        await ping(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      } catch {
        // silent — OS may still be prompting
      }
    };

    void (async () => {
      try {
        await bootstrapAttendanceLocation();
      } catch {
        if (isNativeApp()) {
          try {
            await ensureBackgroundLocationReady();
          } catch {
            /* OS denied — cannot grant silently */
          }
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
    } else if (navigator.geolocation) {
      browserWatchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          void ping(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
        },
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
      );
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
      if (browserWatchRef.current != null) {
        navigator.geolocation.clearWatch(browserWatchRef.current);
        browserWatchRef.current = null;
      }
    };
  }, [isEligible, appActive, onUpdate, profile.role]);

  return null;
}

export { geoActionLabel } from '../utils/geoAttendance';

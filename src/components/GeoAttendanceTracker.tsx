import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  GeoPingResult,
  bootstrapAttendanceLocation,
  requestCurrentPosition,
} from '../utils/geoAttendance';
import { isNativeApp } from '../utils/nativePlatform';

interface GeoAttendanceTrackerProps {
  profile: Profile;
  onUpdate?: () => void;
}

/** Light polling — avoids GPS + RPC storms that freeze the UI */
const POLL_MS_FOREGROUND = 60_000;
const POLL_MS_BACKGROUND = 120_000;
const MIN_PING_GAP_MS = 45_000;

function isClockEvent(action: GeoPingResult['action']): boolean {
  return action === 'clock_in' || action === 'clock_out' || action === 'clock_out_shift_end';
}

/**
 * Background geo attendance. Kept intentionally light:
 * - employees/managers only
 * - interval polling only (no continuous watchPosition)
 * - hard throttle between pings
 */
export default function GeoAttendanceTracker({ profile, onUpdate }: GeoAttendanceTrackerProps) {
  const appActiveRef = useRef(true);
  const busy = useRef(false);
  const lastPingAt = useRef(0);
  const timerRef = useRef<number | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const isEligible = profile.role === 'employee' || profile.role === 'manager';

  useEffect(() => {
    if (!isNativeApp()) return;
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => {
      appActiveRef.current = isActive;
    });
    return () => {
      void sub.then((h) => h.remove());
    };
  }, []);

  useEffect(() => {
    if (!isEligible) return;

    const ping = async (lat: number, lng: number, accuracy: number | null) => {
      const now = Date.now();
      if (busy.current) return;
      if (now - lastPingAt.current < MIN_PING_GAP_MS) return;
      busy.current = true;
      lastPingAt.current = now;
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
          onUpdateRef.current?.();
        }
      } finally {
        busy.current = false;
      }
    };

    const runPing = async () => {
      try {
        // Prefer cached GPS so the UI never waits on a cold high-accuracy lock
        const pos = await requestCurrentPosition({
          maximumAge: 45_000,
          timeout: 12_000,
          enableHighAccuracy: false,
        });
        await ping(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      } catch {
        /* permission / GPS unavailable — stay silent */
      }
    };

    const schedule = () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const ms = isNativeApp() && !appActiveRef.current ? POLL_MS_BACKGROUND : POLL_MS_FOREGROUND;
      timerRef.current = window.setInterval(() => void runPing(), ms);
    };

    void (async () => {
      try {
        await bootstrapAttendanceLocation();
      } catch {
        /* ignore */
      }
      await runPing();
      schedule();
    })();

    const onVisibility = () => {
      appActiveRef.current = document.visibilityState === 'visible';
      schedule();
      if (appActiveRef.current) void runPing();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isEligible]);

  return null;
}

export { geoActionLabel } from '../utils/geoAttendance';

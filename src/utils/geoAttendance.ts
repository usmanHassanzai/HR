/** Geofence attendance — client helpers */

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

export interface OfficeLocation {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  active: boolean;
  is_demo?: boolean;
}

export interface GeoPingResult {
  action: 'clock_in' | 'clock_out' | 'already_clocked_in' | 'already_clocked_out' | 'outside_office' | 'none' | 'skipped';
  inside_office?: boolean;
  office_name?: string;
  distance_meters?: number;
  clock_in_at?: string;
  clock_out_at?: string;
  record_id?: string;
  reason?: string;
}

const GEO_ENABLED_KEY = 'scorr-geo-attendance';

export function isGeoAttendanceEnabled(): boolean {
  try {
    return localStorage.getItem(GEO_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setGeoAttendanceEnabled(enabled: boolean): void {
  localStorage.setItem(GEO_ENABLED_KEY, enabled ? 'true' : 'false');
  window.dispatchEvent(new CustomEvent('scorr-geo-toggle', { detail: enabled }));
}

/** Haversine distance in meters (client-side preview). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(Math.min(1, a)));
}

export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export type GeoPermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported';

export function getGeoPermissionState(): GeoPermissionState {
  if (!navigator.geolocation) return 'unsupported';
  return 'prompt';
}

export function requestCurrentPosition(): Promise<GeolocationPosition> {
  if (Capacitor.isNativePlatform()) {
    return requestNativePosition();
  }
  return requestBrowserPosition();
}

async function requestNativePosition(): Promise<GeolocationPosition> {
  const perm = await Geolocation.checkPermissions();
  if (perm.location === 'denied') {
    throw new Error('Location blocked. Open Settings → Apps → Scorr → Permissions → Location → Allow.');
  }
  if (perm.location !== 'granted') {
    const req = await Geolocation.requestPermissions();
    if (req.location !== 'granted') {
      throw new Error('Location permission required for GPS attendance. Allow location when prompted.');
    }
  }

  const pos = await Geolocation.getCurrentPosition({
    enableHighAccuracy: true,
    timeout: 25000,
    maximumAge: 10000,
  });

  return {
    coords: {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      altitude: pos.coords.altitude ?? null,
      altitudeAccuracy: pos.coords.altitudeAccuracy ?? null,
      heading: pos.coords.heading ?? null,
      speed: pos.coords.speed ?? null,
    },
    timestamp: pos.timestamp,
  } as GeolocationPosition;
}

function requestBrowserPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported on this device. Use a phone or laptop with GPS.'));
      return;
    }
    if (!window.isSecureContext) {
      reject(new Error('Location requires HTTPS. Open the app via https://walfiaai.vercel.app'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        reject(new Error('Location blocked. Allow location permission for this site in your browser settings, then try again.'));
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        reject(new Error('Could not detect GPS. Move near a window, enable device location, and try again.'));
      } else if (err.code === err.TIMEOUT) {
        reject(new Error('Location timed out. Check GPS is on and try again.'));
      } else {
        reject(new Error(err.message || 'Could not get location'));
      }
    }, {
      enableHighAccuracy: true,
      timeout: 25000,
      maximumAge: 10000,
    });
  });
}

export function geoActionLabel(action: GeoPingResult['action']): string {
  switch (action) {
    case 'clock_in': return 'Clocked in at office';
    case 'clock_out': return 'Clocked out (left office)';
    case 'already_clocked_in': return 'Already clocked in today';
    case 'already_clocked_out': return 'Already clocked out today';
    case 'outside_office': return 'Outside office premises';
    case 'skipped': return 'Geo attendance not applicable';
    default: return 'Location checked';
  }
}

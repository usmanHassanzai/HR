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
  action: 'clock_in' | 'clock_out' | 'clock_out_shift_end' | 'already_clocked_in' | 'already_clocked_out' | 'outside_office' | 'shift_not_started' | 'not_work_day' | 'none' | 'skipped';
  inside_office?: boolean;
  office_name?: string;
  distance_meters?: number;
  radius_meters?: number;
  effective_radius_meters?: number;
  accuracy_meters?: number;
  clock_in_at?: string;
  clock_out_at?: string;
  record_id?: string;
  reason?: string;
  shift_name?: string;
  shift_start?: string;
  shift_end?: string;
  work_minutes?: number;
}

export interface AttendanceVisit {
  id: string;
  visit_number: number;
  clock_in_at: string;
  clock_out_at: string | null;
  work_minutes: number | null;
  site_name: string | null;
  notes: string | null;
}

/** Match server geofence: radius + GPS accuracy buffer (min 40m, max +120m). */
export function effectiveGeofenceRadius(radiusMeters: number, accuracyMeters?: number | null): number {
  const accuracy = accuracyMeters == null || Number.isNaN(accuracyMeters) ? 40 : accuracyMeters;
  return radiusMeters + Math.min(120, Math.max(40, accuracy));
}

const GEO_ENABLED_KEY = 'scorr-geo-attendance';

/** Always on — attendance GPS cannot be turned off in-app. */
export function isGeoAttendanceEnabled(): boolean {
  try {
    localStorage.setItem(GEO_ENABLED_KEY, 'true');
  } catch {
    /* ignore */
  }
  return true;
}

/** Kept for callers; always forces ON. */
export function setGeoAttendanceEnabled(_enabled: boolean): void {
  try {
    localStorage.setItem(GEO_ENABLED_KEY, 'true');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('scorr-geo-toggle', { detail: true }));
}

/**
 * Auto-request location as soon as the user is signed in.
 * Phones/browsers still show one system Allow dialog — apps cannot grant location silently.
 */
export async function bootstrapAttendanceLocation(): Promise<void> {
  setGeoAttendanceEnabled(true);

  if (Capacitor.isNativePlatform()) {
    await ensureBackgroundLocationReady();
    await requestCurrentPosition().catch(() => undefined);
    return;
  }

  if (!navigator.geolocation || !window.isSecureContext) return;

  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'denied') return;
    }
  } catch {
    /* Permissions API unsupported — still try getCurrentPosition */
  }

  await requestCurrentPosition().catch(() => undefined);
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

/**
 * Fresh high-accuracy GPS for saving an office pin.
 * Takes several readings and keeps the most accurate — becomes the check-in center.
 */
export async function requestFreshOfficePosition(): Promise<GeolocationPosition> {
  const samples: GeolocationPosition[] = [];
  const attempts = 4;

  for (let i = 0; i < attempts; i++) {
    try {
      const pos = Capacitor.isNativePlatform()
        ? await requestNativePosition({ maximumAge: 0, timeout: 20000 })
        : await requestBrowserPosition({ maximumAge: 0, timeout: 20000 });
      samples.push(pos);
      const acc = pos.coords.accuracy;
      if (acc != null && acc <= 25) break;
    } catch (err) {
      if (i === attempts - 1 && samples.length === 0) throw err;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  if (samples.length === 0) {
    throw new Error('Could not get a fresh GPS reading. Enable location and try again.');
  }

  samples.sort((a, b) => (a.coords.accuracy ?? 9999) - (b.coords.accuracy ?? 9999));
  return samples[0];
}

async function requestNativePosition(opts?: {
  maximumAge?: number;
  timeout?: number;
}): Promise<GeolocationPosition> {
  const perm = await Geolocation.checkPermissions();
  if (perm.location === 'denied' && perm.coarseLocation === 'denied') {
    throw new Error('Location blocked. Open Settings → Apps → Scorr → Permissions → Location → Allow all the time.');
  }
  if (perm.location !== 'granted') {
    const req = await Geolocation.requestPermissions({
      permissions: ['location', 'coarseLocation'],
    });
    if (req.location !== 'granted' && req.coarseLocation !== 'granted') {
      throw new Error('Location permission required for GPS attendance. Allow location when the system asks.');
    }
  }

  const pos = await Geolocation.getCurrentPosition({
    enableHighAccuracy: true,
    timeout: opts?.timeout ?? 25000,
    maximumAge: opts?.maximumAge ?? 10000,
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

function requestBrowserPosition(opts?: {
  maximumAge?: number;
  timeout?: number;
}): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported on this device. Use a phone or laptop with GPS.'));
      return;
    }
    if (!window.isSecureContext) {
      reject(new Error('Location requires HTTPS. Open the app via https://scorr.walfia.ai'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        reject(new Error('Location blocked. Allow location for this site when the browser asks, then reload.'));
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        reject(new Error('Could not detect GPS. Move near a window, enable device location, and try again.'));
      } else if (err.code === err.TIMEOUT) {
        reject(new Error('Location timed out. Check GPS is on and try again.'));
      } else {
        reject(new Error(err.message || 'Could not get location'));
      }
    }, {
      enableHighAccuracy: true,
      timeout: opts?.timeout ?? 25000,
      maximumAge: opts?.maximumAge ?? 10000,
    });
  });
}

export function geoActionLabel(action: GeoPingResult['action']): string {
  switch (action) {
    case 'clock_in': return 'Clocked in at office';
    case 'clock_out': return 'Clocked out (left office)';
    case 'clock_out_shift_end': return 'Clocked out (shift ended)';
    case 'already_clocked_in': return 'On site · visit in progress';
    case 'already_clocked_out': return 'Away from office · visit saved';
    case 'outside_office': return 'Outside office zone';
    case 'shift_not_started': return 'Shift has not started yet';
    case 'not_work_day': return 'Not scheduled to work today';
    case 'skipped': return 'Geo attendance not applicable';
    default: return 'Location checked';
  }
}

/** Request location (incl. background where the OS allows) for attendance while minimized. */
export async function ensureBackgroundLocationReady(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const perm = await Geolocation.checkPermissions();
  if (perm.location === 'denied' && perm.coarseLocation === 'denied') {
    throw new Error('Location blocked. Open Settings → Scorr → Location → Allow all the time.');
  }

  if (perm.location !== 'granted') {
    const req = await Geolocation.requestPermissions({
      permissions: ['location', 'coarseLocation'],
    });
    if (req.location !== 'granted' && req.coarseLocation !== 'granted') {
      throw new Error('Location permission required for automatic attendance.');
    }
  }

  // Re-prompt so Android can offer "Allow all the time" after when-in-use is granted.
  try {
    await Geolocation.requestPermissions({ permissions: ['location'] });
  } catch {
    /* already granted or not supported */
  }
}

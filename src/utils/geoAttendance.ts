/** Geofence attendance — client helpers */

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../lib/supabase';

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

/** Legacy interval constant — continuous GPS polling is disabled. */
export const AUTO_LOCATION_CHECK_MS = 0;

export const GEO_PING_EVENT = 'scorr-geo-ping';
export const GEO_CLOCK_EVENT = 'scorr-geo-clock';
export const GEO_DASHBOARD_OPEN_EVENT = 'scorr-geo-dashboard-open';

export interface GeoPingEventDetail {
  result: GeoPingResult;
  latitude?: number;
  longitude?: number;
  accuracy?: number | null;
  auto?: boolean;
  checkedAt: number;
}

export function dispatchGeoPing(detail: GeoPingEventDetail) {
  window.dispatchEvent(new CustomEvent(GEO_PING_EVENT, { detail }));
  if (
    detail.result.action === 'clock_in' ||
    detail.result.action === 'clock_out' ||
    detail.result.action === 'clock_out_shift_end'
  ) {
    window.dispatchEvent(new CustomEvent(GEO_CLOCK_EVENT, { detail: detail.result }));
  }
}

export function localYmd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
const LAST_GPS_KEY = 'scorr-last-gps-fix';
const LAST_GPS_MAX_AGE_MS = 15 * 60 * 1000;

interface StoredGpsFix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}

function rememberGpsFix(pos: GeolocationPosition): GeolocationPosition {
  try {
    const fix: StoredGpsFix = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
      timestamp: pos.timestamp || Date.now(),
    };
    sessionStorage.setItem(LAST_GPS_KEY, JSON.stringify(fix));
  } catch {
    /* ignore */
  }
  return pos;
}

function storedFixToPosition(fix: StoredGpsFix): GeolocationPosition {
  return {
    coords: {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy ?? 80,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: fix.timestamp,
  } as GeolocationPosition;
}

export function getLastGpsFix(maxAgeMs = LAST_GPS_MAX_AGE_MS): GeolocationPosition | null {
  try {
    const raw = sessionStorage.getItem(LAST_GPS_KEY);
    if (!raw) return null;
    const fix = JSON.parse(raw) as StoredGpsFix;
    if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return null;
    if (Date.now() - fix.timestamp > maxAgeMs) return null;
    return storedFixToPosition(fix);
  } catch {
    return null;
  }
}

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
 * Request when-in-use location permission only. Does not read GPS.
 */
export async function bootstrapAttendanceLocation(): Promise<void> {
  setGeoAttendanceEnabled(true);

  if (Capacitor.isNativePlatform()) {
    await ensureBackgroundLocationReady();
    return;
  }
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

export async function requestCurrentPosition(opts?: {
  maximumAge?: number;
  timeout?: number;
  enableHighAccuracy?: boolean;
}): Promise<GeolocationPosition> {
  const attempts: Array<{ maximumAge: number; timeout: number; enableHighAccuracy: boolean }> = [
    {
      enableHighAccuracy: opts?.enableHighAccuracy ?? false,
      timeout: opts?.timeout ?? 12000,
      maximumAge: opts?.maximumAge ?? 90_000,
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 180_000 },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30_000 },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const pos = Capacitor.isNativePlatform()
        ? await requestNativePosition(attempt)
        : await requestBrowserPosition(attempt);
      return rememberGpsFix(pos);
    } catch (err) {
      lastError = err;
    }
  }

  const cached = getLastGpsFix();
  if (cached) return cached;

  throw lastError instanceof Error
    ? lastError
    : new Error('Location timed out. Check GPS is on and try again.');
}

/** Logout does not read GPS. Clock-out is an explicit attendance action. */
export async function pingAttendanceBeforeLogout(): Promise<void> {
  return;
}

export type GeoClockIntent = 'clock_in' | 'clock_out';

/** One GPS read, then server clock-in or clock-out. No interval logging. */
export async function submitGeoClockEvent(intent: GeoClockIntent): Promise<GeoPingResult> {
  const pos = await requestCurrentPosition({
    maximumAge: 0,
    timeout: 20_000,
    enableHighAccuracy: true,
  });
  const { data, error } = await supabase.rpc('process_geo_attendance_ping', {
    p_latitude: pos.coords.latitude,
    p_longitude: pos.coords.longitude,
    p_accuracy: pos.coords.accuracy ?? null,
    p_intent: intent,
  });
  if (error) throw error;
  const result = data as GeoPingResult;
  dispatchGeoPing({
    result,
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? null,
    auto: false,
    checkedAt: Date.now(),
  });
  return result;
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
  enableHighAccuracy?: boolean;
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
    enableHighAccuracy: opts?.enableHighAccuracy ?? true,
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
  enableHighAccuracy?: boolean;
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
      enableHighAccuracy: opts?.enableHighAccuracy ?? true,
      timeout: opts?.timeout ?? 25000,
      maximumAge: opts?.maximumAge ?? 10000,
    });
  });
}

export function geoActionLabel(action: GeoPingResult['action']): string {
  switch (action) {
    case 'clock_in': return 'Clocked in at office';
    case 'clock_out': return 'Clocked out (exit location saved)';
    case 'clock_out_shift_end': return 'Clocked out (shift ended)';
    case 'already_clocked_in': return 'On site · visit in progress';
    case 'already_clocked_out': return 'Checked out · you can clock in again during the shift';
    case 'outside_office': return 'Outside office zone';
    case 'shift_not_started': return 'Shift has not started yet';
    case 'not_work_day': return 'Not scheduled to work today';
    case 'skipped': return 'Geo attendance not applicable';
    default: return 'Location checked';
  }
}

export type AttendanceWatchId = string | number;

/** Keep watching GPS after the dashboard is closed/minimized. Does not check out by itself. */
export async function watchAttendancePosition(
  onPosition: (lat: number, lng: number, accuracy: number | null) => void,
): Promise<AttendanceWatchId> {
  if (Capacitor.isNativePlatform()) {
    await ensureBackgroundLocationReady();
    return Geolocation.watchPosition(
      {
        enableHighAccuracy: false,
        timeout: 20000,
        maximumAge: 60000,
        minimumUpdateInterval: 60_000,
        interval: 60_000,
      },
      (pos, err) => {
        if (err || !pos) return;
        rememberGpsFix({
          coords: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
            altitude: pos.coords.altitude ?? null,
            altitudeAccuracy: pos.coords.altitudeAccuracy ?? null,
            heading: pos.coords.heading ?? null,
            speed: pos.coords.speed ?? null,
          },
          timestamp: pos.timestamp,
        } as GeolocationPosition);
        onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      },
    );
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported on this device.'));
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        rememberGpsFix(pos);
        onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
      },
      () => undefined,
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 },
    );
    resolve(id);
  });
}

export async function clearAttendanceWatch(id: AttendanceWatchId | null): Promise<void> {
  if (id == null) return;
  if (Capacitor.isNativePlatform() && typeof id === 'string') {
    await Geolocation.clearWatch({ id });
    return;
  }
  if (typeof id === 'number') navigator.geolocation.clearWatch(id);
}

/** When-in-use location only — no background / always-on GPS. */
export async function ensureBackgroundLocationReady(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const perm = await Geolocation.checkPermissions();
  if (perm.location === 'denied' && perm.coarseLocation === 'denied') {
    throw new Error('Location blocked. Open Settings → Scorr → Location → While using the app.');
  }

  if (perm.location !== 'granted') {
    const req = await Geolocation.requestPermissions({
      permissions: ['location', 'coarseLocation'],
    });
    if (req.location !== 'granted' && req.coarseLocation !== 'granted') {
      throw new Error('Location permission is required to clock in or out.');
    }
  }
}

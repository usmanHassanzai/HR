/**
 * Automatic attendance for the iPhone/iPad Home Screen app.
 * No background execution — checks on open, visibility/focus/reconnect,
 * and every 60s while open. Location must be requested from a user gesture
 * on iOS Safari (do not rely on navigator.permissions).
 */
import { isIosHomeScreen } from './nativePlatform';
import {
  fetchAttendanceSchedule,
  getAttendanceDeviceToken,
  sendAutoAttendanceEvent,
} from './attendanceDevice';
import {
  ATTENDANCE_EVENT_MAX_AGE_MS,
  isAttendanceEventFresh,
  logStaleAttendanceDrop,
} from './attendanceStaleQueue';
import { dispatchGeoPing } from './geoAttendance';

const MIN_GAP_MS = 45_000;
const MOVE_METERS = 40;
const OFFICE_VERSION_KEY = 'scorr_att_office_version_ios_home';
export const IOS_HOME_LOCATION_EVENT = 'scorr-ios-home-location';

let watchId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let starting: Promise<void> | null = null;
let inFlight = false;
let lastSentAt = 0;
let lastLat: number | null = null;
let lastLng: number | null = null;
let listenersBound = false;
let lastLocationError: { code: number; message: string } | null = null;
let lastFix: { lat: number; lng: number; accuracy: number | null; at: number } | null = null;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * s2 * s2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function storedOfficeVersion(): number {
  try {
    return Number(localStorage.getItem(OFFICE_VERSION_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function saveOfficeVersion(v: number): void {
  try {
    localStorage.setItem(OFFICE_VERSION_KEY, String(v));
  } catch {
    /* ignore */
  }
}

/** Human message for GeolocationPositionError codes (Home Screen / Safari). */
export function iosHomeLocationErrorMessage(code: number): string {
  switch (code) {
    case 1:
      return (
        'Settings > Privacy & Security > Location Services > Safari Websites > While Using the App, Precise Location on. Then Settings > Apps > Safari > Location > Allow or Ask. Reopen Scorr.'
      );
    case 2:
      return 'Location unavailable. Move near a window and try again.';
    case 3:
      return 'Location timed out. Tap Allow location to retry.';
    default:
      return 'Location failed. Tap Allow location to retry.';
  }
}

export function getIosHomeLocationError(): { code: number; message: string } | null {
  return lastLocationError;
}

export function getIosHomeLastFix(): {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: number;
} | null {
  return lastFix;
}

function emitLocationStatus(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(IOS_HOME_LOCATION_EVENT, {
      detail: { error: lastLocationError, fix: lastFix },
    }),
  );
}

function setLocationError(code: number): void {
  lastLocationError = { code, message: iosHomeLocationErrorMessage(code) };
  console.warn('[scorr-att] ios-home geolocation error', { code, message: lastLocationError.message });
  emitLocationStatus();
}

function clearLocationError(): void {
  lastLocationError = null;
  emitLocationStatus();
}

function getCurrentPositionOnce(
  enableHighAccuracy: boolean,
  timeoutMs: number,
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error('unsupported'), { code: 2 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy,
      timeout: timeoutMs,
      maximumAge: 0,
    });
  });
}

/**
 * Request location: high-accuracy 15s, then one low-accuracy retry on timeout.
 * Must be callable from a user tap so iOS shows the permission prompt.
 */
export async function requestIosHomeLocation(fromUserGesture = false): Promise<{
  ok: boolean;
  position: GeolocationPosition | null;
  errorCode: number | null;
  message: string | null;
}> {
  if (!isIosHomeScreen()) {
    return { ok: false, position: null, errorCode: null, message: null };
  }
  try {
    let pos: GeolocationPosition;
    try {
      pos = await getCurrentPositionOnce(true, 15_000);
    } catch (err) {
      const code = Number((err as GeolocationPositionError)?.code || 0);
      if (code === 3) {
        // Timeout: retry once without high accuracy.
        pos = await getCurrentPositionOnce(false, 15_000);
      } else {
        throw err;
      }
    }
    clearLocationError();
    lastFix = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
      at: Date.now(),
    };
    emitLocationStatus();
    // Update status card Immediately with coords.
    dispatchGeoPing({
      result: {
        action: 'already_clocked_in',
        reason: 'location_fix',
      },
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
      auto: !fromUserGesture,
      checkedAt: Date.now(),
    });
    return { ok: true, position: pos, errorCode: null, message: null };
  } catch (err) {
    const code = Number((err as GeolocationPositionError)?.code || 2);
    setLocationError(code);
    return {
      ok: false,
      position: null,
      errorCode: code,
      message: iosHomeLocationErrorMessage(code),
    };
  }
}

/** User-tap entry: prompts iOS, then sends a ping with the fix. */
export async function allowIosHomeLocationFromTap(): Promise<{
  ok: boolean;
  message: string | null;
}> {
  const result = await requestIosHomeLocation(true);
  if (result.ok && result.position) {
    await sendPingWithPosition(result.position, true);
    return { ok: true, message: null };
  }
  // Still send Wi-Fi-only so attendance keeps working.
  await sendPing(true, false);
  return { ok: false, message: result.message };
}

async function syncOfficeVersion(): Promise<void> {
  try {
    const sched = await fetchAttendanceSchedule();
    if (!sched || typeof sched !== 'object') return;
    let next = Number((sched as { office_version?: number }).office_version || 0) || 0;
    const zones = (sched as { zones?: Array<{ office_version?: number }> }).zones;
    if (Array.isArray(zones)) {
      for (const z of zones) {
        next = Math.max(next, Number(z.office_version || 0) || 0);
      }
    }
    const prev = storedOfficeVersion();
    if (next > 0 && next !== prev) {
      saveOfficeVersion(next);
      console.info('[scorr-att] ios-home office_version changed', { prev, next });
    } else if (next > 0) {
      saveOfficeVersion(next);
    }
  } catch {
    /* keep cached */
  }
}

function applyOfficeVersionFromEvent(res: Record<string, unknown> | null): void {
  if (!res) return;
  let next = Number(res.office_version || 0) || 0;
  const zones = res.zones;
  if (Array.isArray(zones)) {
    for (const z of zones) {
      if (z && typeof z === 'object') {
        next = Math.max(next, Number((z as { office_version?: number }).office_version || 0) || 0);
      }
    }
  }
  if (next > 0 && next !== storedOfficeVersion()) {
    saveOfficeVersion(next);
    void syncOfficeVersion();
  }
}

async function sendPingWithPosition(pos: GeolocationPosition | null, force: boolean): Promise<void> {
  if (!isIosHomeScreen()) return;
  if (inFlight) return;

  if (pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const moved =
      lastLat == null || lastLng == null || metersBetween(lastLat, lastLng, lat, lng) >= MOVE_METERS;
    if (!force && !moved && Date.now() - lastSentAt < MIN_GAP_MS) return;
  } else if (!force && Date.now() - lastSentAt < MIN_GAP_MS) {
    return;
  }

  const now = Date.now();
  const occurred = now;
  if (!isAttendanceEventFresh(occurred, now)) {
    logStaleAttendanceDrop({
      source: 'ios-home',
      event: 'ping',
      age_ms: now - occurred,
      occurred_at_utc_ms: occurred,
    });
    return;
  }
  if (now - occurred > ATTENDANCE_EVENT_MAX_AGE_MS) {
    logStaleAttendanceDrop({
      source: 'ios-home-pre-send',
      event: 'ping',
      age_ms: now - occurred,
      occurred_at_utc_ms: occurred,
    });
    return;
  }

  inFlight = true;
  try {
    const fixTs = pos && Number.isFinite(pos.timestamp) ? pos.timestamp : null;
    const acc = pos?.coords.accuracy ?? null;
    const stale = fixTs != null && occurred - fixTs > 60_000;
    const imprecise = acc != null && acc > 50;
    const sendGps = pos != null && !stale && !imprecise;
    const payload = sendGps
      ? {
          latitude: pos!.coords.latitude,
          longitude: pos!.coords.longitude,
          accuracy_m: acc,
          gps_available: true,
          occurred_at_utc_ms: occurred,
          location_fix_utc_ms: fixTs,
          precise_location: true,
          platform: 'ios' as const,
          app_version: '1.3.17',
          location_error_code: null as number | null,
        }
      : {
          gps_available: false,
          occurred_at_utc_ms: occurred,
          location_fix_utc_ms: fixTs,
          precise_location: !imprecise,
          platform: 'ios' as const,
          app_version: '1.3.17',
          location_error_code: lastLocationError?.code ?? null,
        };
    const res = await sendAutoAttendanceEvent('ping', payload);
    applyOfficeVersionFromEvent(res);
    lastSentAt = Date.now();
    if (pos) {
      lastLat = pos.coords.latitude;
      lastLng = pos.coords.longitude;
      lastFix = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
        at: Date.now(),
      };
      const actionRaw = String(res?.action || res?.reason || 'already_clocked_in');
      const action =
        actionRaw === 'clock_in' ||
        actionRaw === 'clock_out' ||
        actionRaw === 'already_clocked_in' ||
        actionRaw === 'already_checked_in'
          ? actionRaw === 'already_checked_in'
            ? 'already_clocked_in'
            : actionRaw
          : 'already_clocked_in';
      dispatchGeoPing({
        result: {
          action,
          reason: actionRaw,
          inside_office:
            typeof res?.inside_office === 'boolean' ? (res.inside_office as boolean) : undefined,
          distance_meters:
            typeof res?.distance_m === 'number'
              ? (res.distance_m as number)
              : typeof res?.distance_meters === 'number'
                ? (res.distance_meters as number)
                : undefined,
        },
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
        auto: true,
        checkedAt: Date.now(),
      });
    }
  } catch (err) {
    console.warn('[scorr-att] ios-home ping failed', err);
  } finally {
    inFlight = false;
  }
}

async function sendPing(force: boolean, preferAccurateOutside: boolean): Promise<void> {
  if (!isIosHomeScreen()) return;
  if (inFlight) return;

  let pos: GeolocationPosition | null = null;
  if (preferAccurateOutside) {
    const first = await requestIosHomeLocation(false);
    pos = first.position;
    if (!pos) {
      // Already recorded error; still ping Wi-Fi-only.
    }
  } else {
    try {
      pos = await getCurrentPositionOnce(true, 15_000);
      clearLocationError();
    } catch (err) {
      const code = Number((err as GeolocationPositionError)?.code || 0);
      if (code === 3) {
        try {
          pos = await getCurrentPositionOnce(false, 15_000);
          clearLocationError();
        } catch (err2) {
          setLocationError(Number((err2 as GeolocationPositionError)?.code || 3));
        }
      } else {
        setLocationError(code || 2);
      }
    }
  }

  await sendPingWithPosition(pos, force);
}

async function pingNow(force: boolean): Promise<void> {
  if (!isIosHomeScreen()) return;
  await syncOfficeVersion();
  await sendPing(force, true);
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void pingNow(true);
}

function bindResume(): void {
  if (listenersBound || typeof document === 'undefined') return;
  listenersBound = true;
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', () => void pingNow(true));
  window.addEventListener('focus', () => void pingNow(true));
  window.addEventListener('online', () => void pingNow(true));
}

/** Banner: Home Screen works only while open; Safari location steps. */
export const IOS_HOME_BACKGROUND_BANNER =
  'The Home Screen app works only while open. For automatic check-in and check-out, install the Scorr iPhone app.';

export const IOS_HOME_LOCATION_STEPS =
  'Allow location for Safari: Settings > Privacy & Security > Location Services > Safari Websites > While Using the App (Precise Location on). Then Settings > Apps > Safari > Location > Allow or Ask. Scorr does not appear under Location Services by name — it is a Safari website.';

/** Start GPS automatic attendance. No-op unless this is the iOS Home Screen app with a token. */
export function startIosHomeAttendance(): Promise<void> {
  if (!isIosHomeScreen() || started) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    const token = await getAttendanceDeviceToken();
    if (!token) return;
    if (started) return;
    started = true;
    bindResume();
    await syncOfficeVersion();

    // Do not use watchPosition with a large maximumAge — it serves stale fixes on iOS.
    // Poll via getCurrentPosition on the 60s timer and resume events instead.
    if (watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    timer = setInterval(() => {
      void sendPing(false, true);
    }, 60_000);

    void pingNow(true);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export function stopIosHomeAttendance(): void {
  started = false;
  starting = null;
  lastSentAt = 0;
  lastLat = null;
  lastLng = null;
  if (watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
  if (timer != null) clearInterval(timer);
  timer = null;
}

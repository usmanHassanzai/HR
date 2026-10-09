/**
 * Automatic attendance for the iPhone/iPad Home Screen app.
 * Same device-token GPS pings as the Android app: check in inside the office,
 * check out when the fix is outside. A Home Screen app cannot run in the
 * background. Scorr checks on open and every 60 seconds while it stays open.
 */
import { isIosHomeScreen } from './nativePlatform';
import { getAttendanceDeviceToken, sendAutoAttendanceEvent } from './attendanceDevice';

const MIN_GAP_MS = 45_000;
const MOVE_METERS = 40;

let watchId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let starting: Promise<void> | null = null;
let inFlight = false;
let lastSentAt = 0;
let lastLat: number | null = null;
let lastLng: number | null = null;
let listenersBound = false;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * s2 * s2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function readPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 0,
    });
  });
}

async function sendFix(pos: GeolocationPosition, force: boolean): Promise<void> {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const moved =
    lastLat == null || lastLng == null || metersBetween(lastLat, lastLng, lat, lng) >= MOVE_METERS;
  if (!force && !moved && Date.now() - lastSentAt < MIN_GAP_MS) return;
  if (inFlight) return;
  inFlight = true;
  try {
    await sendAutoAttendanceEvent('ping', {
      latitude: lat,
      longitude: lng,
      accuracy_m: pos.coords.accuracy ?? null,
      platform: 'ios',
    });
    lastSentAt = Date.now();
    lastLat = lat;
    lastLng = lng;
  } catch {
    /* next tick retries */
  } finally {
    inFlight = false;
  }
}

async function pingNow(force: boolean): Promise<void> {
  if (!isIosHomeScreen()) return;
  try {
    const pos = await readPosition();
    await sendFix(pos, force);
  } catch {
    /* permission or timeout — watcher retries */
  }
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

/** Banner copy for the Home Screen web app limitation. */
export const IOS_HOME_BACKGROUND_BANNER =
  'Background check-out is not available on the Home Screen app. Open Scorr to update your status, or use the Scorr iPhone app.';

/** Start GPS automatic attendance. No-op unless this is the iOS Home Screen app with a token. */
export function startIosHomeAttendance(): Promise<void> {
  if (!isIosHomeScreen() || started) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    const token = await getAttendanceDeviceToken();
    if (!token || !navigator.geolocation) return;
    if (started) return;
    started = true;
    bindResume();

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        void sendFix(pos, false);
      },
      () => {
        /* denied or unavailable — interval asks again */
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );

    timer = setInterval(() => {
      void pingNow(false);
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

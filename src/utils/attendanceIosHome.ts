/**
 * Automatic attendance for the iPhone/iPad Home Screen app.
 * No background execution — checks on open, visibility/focus/reconnect,
 * and every 60s while open. Matches Android payload rules for items
 * 4, 5, 6, 9, 11, 12, 13 (foreground-only equivalent).
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

const MIN_GAP_MS = 45_000;
const MOVE_METERS = 40;
const OFFICE_VERSION_KEY = 'scorr_att_office_version_ios_home';

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

/** Fresh event time — never trust a stale GPS fix timestamp. */
function freshOccurredMs(pos: GeolocationPosition | null): number {
  const now = Date.now();
  if (!pos) return now;
  const t = pos.timestamp;
  if (!Number.isFinite(t) || t <= 0) return now;
  if (now - t > 2 * 60 * 1000 || t - now > 60 * 1000) return now;
  return t;
}

async function readPositionOrNull(timeoutMs = 3000): Promise<GeolocationPosition | null> {
  if (!navigator.geolocation) return null;
  try {
    return await Promise.race([
      new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: timeoutMs,
          maximumAge: 0,
        });
      }),
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/** Up to 3 fresh readings within ~15s until accuracy ≤ maxAcc. */
async function readPositionWithAccuracyRetries(maxAcc: number): Promise<GeolocationPosition | null> {
  let best: GeolocationPosition | null = null;
  for (let i = 0; i < 3; i++) {
    const pos = await readPositionOrNull(5_000);
    if (pos) {
      if (!best || (pos.coords.accuracy ?? 9999) < (best.coords.accuracy ?? 9999)) best = pos;
      if ((pos.coords.accuracy ?? 9999) <= maxAcc) return pos;
    }
  }
  return best;
}

async function syncOfficeVersion(): Promise<void> {
  try {
    const sched = await fetchAttendanceSchedule();
    if (!sched || typeof sched !== 'object') return;
    let next = Number((sched as { office_version?: number }).office_version || 0) || 0;
    const zones = (sched as { zones?: Array<{ office_version?: number; radius_meters?: number }> }).zones;
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

async function sendPing(force: boolean, preferAccurateOutside: boolean): Promise<void> {
  if (!isIosHomeScreen()) return;
  if (inFlight) return;

  // Prefer ≤50 m when checking for auto outside check-out; otherwise ≤3s then Wi-Fi-only.
  const pos = preferAccurateOutside
    ? await readPositionWithAccuracyRetries(50)
    : await readPositionOrNull(3000);

  if (pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const moved =
      lastLat == null || lastLng == null || metersBetween(lastLat, lastLng, lat, lng) >= MOVE_METERS;
    if (!force && !moved && Date.now() - lastSentAt < MIN_GAP_MS) return;
  } else if (!force && Date.now() - lastSentAt < MIN_GAP_MS) {
    return;
  }

  const occurred = freshOccurredMs(pos);
  const now = Date.now();
  if (!isAttendanceEventFresh(occurred, now)) {
    logStaleAttendanceDrop({
      source: 'ios-home',
      event: 'ping',
      age_ms: now - occurred,
      occurred_at_utc_ms: occurred,
    });
    return;
  }
  // Drop anything older than 10 minutes (defensive; freshOccurredMs should prevent this).
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
    // Home Screen cannot read Precise Location; treat accuracy > 50 as reduced.
    const sendGps = pos != null && !stale && !imprecise;
    const payload = sendGps
      ? {
          latitude: pos!.coords.latitude,
          longitude: pos!.coords.longitude,
          accuracy_m: acc,
          gps_available: true,
          occurred_at_utc_ms: Date.now(),
          location_fix_utc_ms: fixTs,
          precise_location: true,
          platform: 'ios' as const,
          app_version: '1.3.15',
        }
      : {
          gps_available: false,
          occurred_at_utc_ms: Date.now(),
          location_fix_utc_ms: fixTs,
          precise_location: !imprecise,
          platform: 'ios' as const,
          app_version: '1.3.15',
        };
    const res = await sendAutoAttendanceEvent('ping', payload);
    applyOfficeVersionFromEvent(res);
    lastSentAt = Date.now();
    if (pos) {
      lastLat = pos.coords.latitude;
      lastLng = pos.coords.longitude;
    }
  } catch (err) {
    console.warn('[scorr-att] ios-home ping failed', err);
  } finally {
    inFlight = false;
  }
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

/** Banner copy for the Home Screen web app limitation. */
export const IOS_HOME_BACKGROUND_BANNER =
  'Background check-out is not available on the Home Screen app. Open Scorr to update your status, or use the Scorr iPhone app.';

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

    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        () => {
          void sendPing(false, false);
        },
        () => {
          // Location denied / unavailable — send Wi-Fi-only immediately (no local block).
          void sendPing(true, false);
        },
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
      );
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

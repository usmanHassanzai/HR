/** Client-side attendance event freshness (10 minutes). */

export const ATTENDANCE_EVENT_MAX_AGE_MS = 10 * 60 * 1000;

export type StaleDropLog = {
  at: number;
  source: string;
  event?: string;
  age_ms: number;
  occurred_at_utc_ms?: number;
};

const LOG_KEY = 'scorr_att_stale_drops';
const LOG_MAX = 100;

export function logStaleAttendanceDrop(entry: Omit<StaleDropLog, 'at'>): void {
  const row: StaleDropLog = { at: Date.now(), ...entry };
  console.info('[scorr-att] dropped stale event', row);
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const prev = raw ? (JSON.parse(raw) as StaleDropLog[]) : [];
    const next = [...prev, row].slice(-LOG_MAX);
    localStorage.setItem(LOG_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function getStaleAttendanceDropLog(): StaleDropLog[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as StaleDropLog[]) : [];
  } catch {
    return [];
  }
}

/** connection_lost may arrive late and is only used to close a visit. */
export function isConnectionLostEvent(event?: string | null): boolean {
  return String(event || '').toLowerCase() === 'connection_lost';
}

/** True when occurred_at is fresh enough to send. */
export function isAttendanceEventFresh(
  occurredAtUtcMs: number,
  nowMs = Date.now(),
  event?: string | null,
): boolean {
  if (!Number.isFinite(occurredAtUtcMs) || occurredAtUtcMs <= 0) return false;
  if (isConnectionLostEvent(event)) return true;
  return nowMs - occurredAtUtcMs <= ATTENDANCE_EVENT_MAX_AGE_MS;
}

/**
 * From a queued list, drop anything older than 10 minutes and keep only the newest.
 * Logs each drop. Returns null when nothing remains.
 */
export function takeNewestFreshEvent<T extends { occurred_at_utc_ms?: number; event?: string }>(
  queue: T[],
  source: string,
  nowMs = Date.now(),
): T | null {
  if (!queue.length) return null;
  const fresh: T[] = [];
  // Prefer a pending connection_lost (exact disconnect time) before a fresh reading.
  const lost = queue.filter((item) => isConnectionLostEvent(item.event));
  if (lost.length) {
    lost.sort((a, b) => Number(a.occurred_at_utc_ms ?? 0) - Number(b.occurred_at_utc_ms ?? 0));
    return lost[0];
  }
  for (const item of queue) {
    const occurred = Number(item.occurred_at_utc_ms ?? 0);
    if (!isAttendanceEventFresh(occurred, nowMs, item.event)) {
      logStaleAttendanceDrop({
        source,
        event: item.event,
        age_ms: occurred > 0 ? nowMs - occurred : -1,
        occurred_at_utc_ms: occurred > 0 ? occurred : undefined,
      });
      continue;
    }
    fresh.push(item);
  }
  if (!fresh.length) return null;
  fresh.sort((a, b) => Number(b.occurred_at_utc_ms ?? 0) - Number(a.occurred_at_utc_ms ?? 0));
  // Drop older fresh siblings so only the newest is sent.
  for (const dropped of fresh.slice(1)) {
    logStaleAttendanceDrop({
      source: `${source}:superseded`,
      event: dropped.event,
      age_ms: nowMs - Number(dropped.occurred_at_utc_ms ?? nowMs),
      occurred_at_utc_ms: Number(dropped.occurred_at_utc_ms ?? 0) || undefined,
    });
  }
  return fresh[0];
}

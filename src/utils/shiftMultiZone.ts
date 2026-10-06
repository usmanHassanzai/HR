/**
 * Multi-zone shift time math (R76–R79).
 * All conversions use IANA rules via Intl (DST, half-hour offsets).
 * No hardcoded country offsets or DST calendar dates.
 */

import { formatZoneOffset, zoneShortLabel } from './ianaTimezones';

export type ShiftOfficeTime = {
  timezone: string;
  start: string; // HH:MM
  end: string; // HH:MM
};

export type ShiftDisplayZoneRow = {
  timezone: string;
  entered_start_time: string;
  entered_end_time: string;
  sort_order: number;
};

const HM = /^(\d{1,2}):(\d{2})$/;

export function parseHm(t: string): { h: number; m: number } | null {
  const m = HM.exec((t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

export function formatHm(h: number, m: number): string {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
}

function ymdInZone(at: Date, timeZone: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day') };
}

function hmInZone(at: Date, timeZone: string): { h: number; m: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { h: get('hour'), m: get('minute'), s: get('second') };
}

/**
 * Convert a civil wall time in `timeZone` on calendar date `onYmd` (YYYY-MM-DD) to a UTC Date.
 *
 * DST rules (documented):
 * - Spring-forward gap (non-existent local time): snap forward to the first valid
 *   instant after the gap (typically +1h from the missing wall time).
 * - Fall-back overlap (ambiguous local time): use the earlier occurrence
 *   (standard "first" instance before the clock repeats).
 */
export function zonedWallTimeToUtc(onYmd: string, hm: string, timeZone: string): Date {
  const [ys, mos, ds] = onYmd.split('-').map(Number);
  const parsed = parseHm(hm);
  if (!parsed || !ys || !mos || !ds) return new Date(NaN);

  const wantedAsUtc = Date.UTC(ys, mos - 1, ds, parsed.h, parsed.m, 0);
  let guess = wantedAsUtc;

  for (let i = 0; i < 5; i++) {
    const got = ymdInZone(new Date(guess), timeZone);
    const gotHm = hmInZone(new Date(guess), timeZone);
    const gotAsUtc = Date.UTC(got.y, got.mo - 1, got.d, gotHm.h, gotHm.m, gotHm.s);
    const delta = gotAsUtc - guess;
    // wanted wall expressed as fake-UTC minus observed delta ≈ real UTC
    const next = wantedAsUtc - delta;
    if (Math.abs(next - guess) < 1000) {
      guess = next;
      break;
    }
    guess = next;
  }

  // Detect spring-forward gap: formatted local time still ≠ requested
  const check = hmInZone(new Date(guess), timeZone);
  const checkYmd = ymdInZone(new Date(guess), timeZone);
  const sameWall =
    checkYmd.y === ys &&
    checkYmd.mo === mos &&
    checkYmd.d === ds &&
    check.h === parsed.h &&
    check.m === parsed.m;
  if (!sameWall) {
    // Snap forward minute-by-minute up to 3 hours to first valid local time on that calendar day
    for (let addMin = 1; addMin <= 180; addMin++) {
      const cand = new Date(guess + addMin * 60_000);
      const cY = ymdInZone(cand, timeZone);
      const cH = hmInZone(cand, timeZone);
      if (cY.y === ys && cY.mo === mos && cY.d === ds) {
        // first instant whose local HM is >= requested (after gap)
        const mins = cH.h * 60 + cH.m;
        const want = parsed.h * 60 + parsed.m;
        if (mins >= want) return cand;
      }
    }
  }
  return new Date(guess);
}

export function utcToZonedWall(utc: Date, timeZone: string): {
  ymd: string;
  hm: string;
  dayOffsetFrom: (baseYmd: string) => number;
} {
  const { y, mo, d } = ymdInZone(utc, timeZone);
  const { h, m } = hmInZone(utc, timeZone);
  const ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return {
    ymd,
    hm: formatHm(h, m),
    dayOffsetFrom(baseYmd: string) {
      const a = Date.parse(`${baseYmd}T00:00:00Z`);
      const b = Date.parse(`${ymd}T00:00:00Z`);
      return Math.round((b - a) / 86_400_000);
    },
  };
}

/** Reference calendar date in main zone for "today" conversions (fixed or live). */
export function todayYmdInZone(timeZone: string, now: Date = new Date()): string {
  const { y, mo, d } = ymdInZone(now, timeZone);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function convertOfficeTime(
  from: ShiftOfficeTime,
  toTimezone: string,
  onYmd: string,
): ShiftOfficeTime {
  const startUtc = zonedWallTimeToUtc(onYmd, from.start, from.timezone);
  const endUtc = zonedWallTimeToUtc(
    // if overnight in from zone, end is next calendar day
    isOvernightHm(from.start, from.end) ? addDaysYmd(onYmd, 1) : onYmd,
    from.end,
    from.timezone,
  );
  const startWall = utcToZonedWall(startUtc, toTimezone);
  const endWall = utcToZonedWall(endUtc, toTimezone);
  return {
    timezone: toTimezone,
    start: startWall.hm,
    end: endWall.hm,
  };
}

export function isOvernightHm(start: string, end: string): boolean {
  const a = parseHm(start);
  const b = parseHm(end);
  if (!a || !b) return false;
  return b.h * 60 + b.m <= a.h * 60 + a.m;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const SAME_MOMENT_TOLERANCE_MS = 60_000; // 1 minute

export type SameMomentResult =
  | { ok: true }
  | { ok: false; message: string; expected: ShiftOfficeTime };

/**
 * All office times must describe the same UTC start (and end) on `onYmd` in the main zone's calendar.
 */
export function validateSameMoment(
  main: ShiftOfficeTime,
  others: ShiftOfficeTime[],
  onYmd: string,
): SameMomentResult {
  const mainStart = zonedWallTimeToUtc(onYmd, main.start, main.timezone);
  const mainEndYmd = isOvernightHm(main.start, main.end) ? addDaysYmd(onYmd, 1) : onYmd;
  const mainEnd = zonedWallTimeToUtc(mainEndYmd, main.end, main.timezone);
  if (Number.isNaN(mainStart.getTime()) || Number.isNaN(mainEnd.getTime())) {
    return { ok: false, message: 'Invalid main office time.', expected: main };
  }

  for (const o of others) {
    if (!o.timezone || !o.start || !o.end) continue;
    const expected = convertOfficeTime(main, o.timezone, onYmd);
    const oStart = zonedWallTimeToUtc(onYmd, o.start, o.timezone);
    // Compare using expected conversion if overnight differs per zone
    const expStart = zonedWallTimeToUtc(onYmd, expected.start, o.timezone);
    if (Math.abs(oStart.getTime() - mainStart.getTime()) > SAME_MOMENT_TOLERANCE_MS) {
      const label = zoneShortLabel(o.timezone);
      const mainLabel = zoneShortLabel(main.timezone);
      return {
        ok: false,
        message: `${formatClock12(main.start)} ${mainLabel} is ${formatClock12(expected.start)} in ${label} today, not ${formatClock12(o.start)}.`,
        expected,
      };
    }
    void expStart;
    void mainEnd;
  }
  return { ok: true };
}

function formatClock12(hm: string): string {
  const p = parseHm(hm);
  if (!p) return hm;
  const d = new Date();
  d.setHours(p.h, p.m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export type FormattedZoneRange = {
  timezone: string;
  label: string;
  text: string;
  dayDeltaStart: number;
  dayDeltaEnd: number;
};

/**
 * Display ranges for main + display zones, recalculated from main for `onYmd`.
 */
export function formatShiftZonesForDate(
  main: ShiftOfficeTime,
  displayZones: { timezone: string }[],
  onYmd: string,
  viewerTz?: string | null,
): FormattedZoneRange[] {
  const startUtc = zonedWallTimeToUtc(onYmd, main.start, main.timezone);
  const endYmd = isOvernightHm(main.start, main.end) ? addDaysYmd(onYmd, 1) : onYmd;
  const endUtc = zonedWallTimeToUtc(endYmd, main.end, main.timezone);

  const zones = [main.timezone, ...displayZones.map((z) => z.timezone).filter((z) => z && z !== main.timezone)];
  const out: FormattedZoneRange[] = zones.map((tz) => {
    const s = utcToZonedWall(startUtc, tz);
    const e = utcToZonedWall(endUtc, tz);
    const dayDeltaStart = s.dayOffsetFrom(onYmd);
    const dayDeltaEnd = e.dayOffsetFrom(onYmd);
    const startLabel = formatClock12(s.hm) + dayDeltaTag(dayDeltaStart);
    const endLabel = formatClock12(e.hm) + dayDeltaTag(dayDeltaEnd);
    return {
      timezone: tz,
      label: zoneShortLabel(tz),
      text: `${startLabel} – ${endLabel} ${zoneShortLabel(tz)}`,
      dayDeltaStart,
      dayDeltaEnd,
    };
  });

  if (viewerTz && !zones.includes(viewerTz)) {
    const s = utcToZonedWall(startUtc, viewerTz);
    const e = utcToZonedWall(endUtc, viewerTz);
    out.push({
      timezone: viewerTz,
      label: `Your device (${zoneShortLabel(viewerTz)})`,
      text: `${formatClock12(s.hm)}${dayDeltaTag(s.dayOffsetFrom(onYmd))} – ${formatClock12(e.hm)}${dayDeltaTag(e.dayOffsetFrom(onYmd))} your local time`,
      dayDeltaStart: s.dayOffsetFrom(onYmd),
      dayDeltaEnd: e.dayOffsetFrom(onYmd),
    });
  }
  return out;
}

function dayDeltaTag(delta: number): string {
  if (delta > 0) return ` (+${delta} day${delta > 1 ? 's' : ''})`;
  if (delta < 0) return ` (${delta} day${delta < -1 ? 's' : ''})`;
  return '';
}

export function formatShiftZonesLine(
  main: ShiftOfficeTime,
  displayZones: { timezone: string }[],
  onYmd: string,
  viewerTz?: string | null,
): string {
  return formatShiftZonesForDate(main, displayZones, onYmd, viewerTz)
    .map((z) => z.text)
    .join(' · ');
}

/**
 * Find the next date (within `horizonDays`) where a non-main zone's displayed
 * start/end HM differs from today's conversion — typically a DST boundary.
 * Dates are discovered by scanning; nothing is hardcoded per country.
 */
export function nextDisplayChangeDate(
  main: ShiftOfficeTime,
  otherTz: string,
  fromYmd: string,
  horizonDays = 400,
): { onYmd: string; newStart: string; newEnd: string } | null {
  const base = convertOfficeTime(main, otherTz, fromYmd);
  for (let i = 1; i <= horizonDays; i++) {
    const ymd = addDaysYmd(fromYmd, i);
    const next = convertOfficeTime(main, otherTz, ymd);
    if (next.start !== base.start || next.end !== base.end) {
      return { onYmd: ymd, newStart: next.start, newEnd: next.end };
    }
  }
  return null;
}

export function describeUpcomingDstChanges(
  main: ShiftOfficeTime,
  others: { timezone: string }[],
  fromYmd: string,
): string[] {
  const lines: string[] = [];
  for (const o of others) {
    if (!o.timezone || o.timezone === main.timezone) continue;
    const ch = nextDisplayChangeDate(main, o.timezone, fromYmd);
    if (!ch) continue;
    lines.push(
      `From ${ch.onYmd}, ${zoneShortLabel(o.timezone)} time becomes ${formatClock12(ch.newStart)} – ${formatClock12(ch.newEnd)}.`,
    );
  }
  return lines;
}

export function withinDays(ymd: string, fromYmd: string, days: number): boolean {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${ymd}T00:00:00Z`);
  const diff = Math.round((b - a) / 86_400_000);
  return diff >= 0 && diff <= days;
}

export function offsetLabel(timeZone: string, at: Date = new Date()): string {
  return formatZoneOffset(timeZone, at);
}

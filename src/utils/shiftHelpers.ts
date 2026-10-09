/** Work shift types and formatting helpers */

export interface WorkShift {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  grace_minutes: number;
  active: boolean;
  crosses_midnight?: boolean;
  apply_to_all?: boolean;
  assigned_count?: number;
  /** Main IANA zone — drives attendance window */
  timezone?: string | null;
}

export interface MyShift {
  shift_id: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  days_of_week: number[];
  effective_from: string;
  crosses_midnight?: boolean;
  /** IANA zone for this shift (e.g. America/Chicago). Display default may still be company TZ. */
  timezone?: string;
}

export interface TeamShiftAssignment {
  user_id: string;
  full_name: string;
  email: string;
  shift_id: string | null;
  shift_name: string | null;
  start_time: string | null;
  end_time: string | null;
  effective_from: string | null;
  /** True when this person has personal hours instead of the shared shift template. */
  hours_custom?: boolean | null;
  crosses_midnight?: boolean | null;
}

export interface AttendanceHistoryRow {
  id: string;
  attendance_date: string;
  status: string;
  approval_status: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  attendance_source: string | null;
  work_minutes: number | null;
  shift_name: string | null;
  notes: string | null;
  /** Number of visits in the shift (from shared duration SSOT). */
  visit_count?: number | null;
}

export interface TeamAttendanceHistoryRow extends AttendanceHistoryRow {
  user_id: string;
  employee_name: string;
  employee_role: string;
  department_name: string | null;
}

export interface MonthlyAttendanceReport {
  report_id: string;
  report_year: number;
  report_month: number;
  department_id: string | null;
  department_name: string | null;
  record_count: number;
  employee_count: number;
  generated_at: string;
}

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Prefer company/shift zone; never invent Asia/Karachi or America/Chicago. */
export function resolveAppTimeZone(preferred?: string | null): string {
  if (preferred && preferred.trim()) return preferred.trim();
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** @deprecated Use resolveAppTimeZone — kept as alias for older imports. */
export const APP_TIMEZONE = resolveAppTimeZone();

/** @deprecated Viewer/device zone is preferred over any office fallback. */
export const OFFICE_DISPLAY_TZ_FALLBACK = resolveAppTimeZone();

export function formatShiftTime(t: string | null | undefined): string {
  if (!t) return '—';
  const [h, m] = t.split(':');
  const d = new Date();
  d.setHours(Number(h), Number(m), 0, 0);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatShiftTimeRange(
  start: string,
  end: string,
  crossesMidnight?: boolean,
): string {
  const overnight = crossesMidnight ?? isOvernightShift(start, end);
  const range = `${formatShiftTime(start)} – ${formatShiftTime(end)}`;
  return overnight ? `${range} (next day)` : range;
}

export function isOvernightShift(start: string, end: string): boolean {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em <= sh * 60 + sm;
}

export function formatShiftDays(days: number[]): string {
  return formatWorkingDays(days);
}

/** Compact label: Mon–Fri, Sat–Sun, Every day, or custom (Mon, Wed, Fri). */
export function formatWorkingDays(days: number[]): string {
  if (!days?.length) return 'Not set';
  const unique = [...new Set(days.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (unique.length === 7) return 'Every day';
  if (unique.join(',') === '1,2,3,4,5') return 'Mon–Fri';
  if (unique.join(',') === '6,7') return 'Sat–Sun';
  const parts: string[] = [];
  let i = 0;
  while (i < unique.length) {
    let j = i;
    while (j + 1 < unique.length && unique[j + 1] === unique[j] + 1) j += 1;
    if (j >= i + 2) {
      parts.push(`${DAY_LABELS[unique[i] - 1]}–${DAY_LABELS[unique[j] - 1]}`);
    } else if (j === i + 1) {
      parts.push(`${DAY_LABELS[unique[i] - 1]}, ${DAY_LABELS[unique[j] - 1]}`);
    } else {
      parts.push(DAY_LABELS[unique[i] - 1] ?? '?');
    }
    i = j + 1;
  }
  return parts.join(', ');
}

export function formatWorkDuration(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return 'Not logged';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** True when out is missing or not after in (same-minute / inverted bad rows). */
export function isInvalidClockOutPair(
  clockInAt?: string | null,
  clockOutAt?: string | null,
): boolean {
  if (!clockInAt || !clockOutAt) return true;
  const inMs = Date.parse(clockInAt);
  const outMs = Date.parse(clockOutAt);
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) return true;
  return outMs <= inMs;
}

/**
 * Prefer a real out stamp after in; if the stored out equals/precedes in but
 * work_minutes is known (common auto_gps / admin_correction bug), derive out.
 */
export function resolveEffectiveClockOut(row: {
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  work_minutes?: number | null;
}): string | null {
  if (!row.clock_in_at) return row.clock_out_at ?? null;
  if (!isInvalidClockOutPair(row.clock_in_at, row.clock_out_at)) {
    return row.clock_out_at ?? null;
  }
  const mins = row.work_minutes != null && row.work_minutes > 0 ? row.work_minutes : null;
  if (mins != null) {
    const inMs = Date.parse(row.clock_in_at);
    if (Number.isFinite(inMs)) return new Date(inMs + mins * 60_000).toISOString();
  }
  // Invalid/equal out with no duration → treat as still open for display.
  return null;
}

function elapsedMinutesSince(iso: string): number {
  const inMs = Date.parse(iso);
  if (!Number.isFinite(inMs)) return 0;
  return Math.max(0, Math.round((Date.now() - inMs) / 60000));
}

/**
 * Open re-check-ins store the worked total (closed visits + the current visit),
 * which is shorter than the wall clock since the first clock-in because of the gaps.
 * Keep counting from that snapshot so the open visit does not freeze.
 */
const openVisitBaselines = new Map<string, { minutes: number; at: number }>();

function liveOpenWorkedMinutes(row: {
  attendance_date?: string | null;
  clock_in_at?: string | null;
  work_minutes?: number | null;
}): number {
  const clockIn = row.clock_in_at || '';
  const wall = elapsedMinutesSince(clockIn);
  const stored = row.work_minutes != null && row.work_minutes > 0 ? row.work_minutes : null;
  // One continuous visit: minutes track the clock. Use the clock so it keeps moving.
  if (stored == null || wall <= stored + 15) return wall;

  const key = `${row.attendance_date || ''}|${clockIn}|${stored}`;
  let base = openVisitBaselines.get(key);
  if (!base) {
    base = { minutes: stored, at: Date.now() };
    openVisitBaselines.set(key, base);
  }
  const extra = Math.max(0, Math.round((Date.now() - base.at) / 60000));
  return base.minutes + extra;
}

export function resolveWorkMinutes(row: {
  attendance_date?: string | null;
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  work_minutes?: number | null;
}): number | null {
  const stored = row.work_minutes != null && row.work_minutes >= 0 ? row.work_minutes : null;

  // History / team RPCs already return the shared shift sum of every visit.
  // Trust that total — do not replace it with first-in→last-out wall clock.
  if (row.clock_in_at && !row.clock_out_at) {
    return liveOpenWorkedMinutes(row);
  }
  if (stored != null) return stored;

  const inMs = row.clock_in_at ? Date.parse(row.clock_in_at) : NaN;
  const outMs = row.clock_out_at ? Date.parse(row.clock_out_at) : NaN;
  if (Number.isFinite(inMs) && Number.isFinite(outMs) && outMs > inMs) {
    return Math.round((outMs - inMs) / 60000);
  }
  return null;
}

function formatHistoryDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function describeAttendanceHistory(row: {
  shift_name?: string | null;
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  work_minutes?: number | null;
  attendance_date?: string | null;
  visit_count?: number | null;
}): {
  shift: string;
  clockIn: string;
  clockOut: string;
  duration: string;
  shiftEmpty: boolean;
  clockOutEmpty: boolean;
  durationEmpty: boolean;
  stillPresent: boolean;
} {
  const shift = row.shift_name?.trim() || 'Unassigned';
  const effectiveOut = resolveEffectiveClockOut(row);
  // A missing clock-out means a visit is still open, including a check-in after an earlier visit.
  // Do not turn the worked-minutes total into a clock-out — that total is shorter than the
  // wall clock when they left and came back.
  const stillOpen = Boolean(row.clock_in_at) && !row.clock_out_at;
  const clockIn = row.clock_in_at ? formatHistoryDateTime(row.clock_in_at) : 'No clock-in';
  const clockOut = stillOpen
    ? 'Still present in office'
    : effectiveOut
      ? formatHistoryDateTime(effectiveOut)
      : 'No clock-out';
  const mins = resolveWorkMinutes(row);
  const visits =
    row.visit_count != null && row.visit_count > 0
      ? ` · ${row.visit_count} visit${row.visit_count === 1 ? '' : 's'}`
      : '';
  let duration = formatWorkDuration(mins);
  if (stillOpen) {
    duration = mins != null && mins > 0
      ? `${formatWorkDuration(mins)} · still working`
      : 'Still working';
  }
  if (duration && visits) duration = `${duration}${visits}`;
  return {
    shift,
    clockIn,
    clockOut,
    duration,
    shiftEmpty: !row.shift_name?.trim(),
    clockOutEmpty: !effectiveOut && !stillOpen,
    durationEmpty: !stillOpen && (mins == null || mins <= 0),
    stillPresent: stillOpen,
  };
}

export function isTodayWorkDay(days: number[]): boolean {
  return days.includes(isoDowInAppTimezone());
}

/**
 * Display helpers accept an explicit IANA zone (shift.timezone).
 * Do not hardcode a country default here.
 */
function isoDowInTimezone(timeZone: string, at = new Date()): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[weekday] ?? 1;
}

function minutesInTimezone(timeZone: string, at = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function isoDowInAppTimezone(at = new Date()): number {
  return isoDowInTimezone(APP_TIMEZONE, at);
}

/** Format an instant in device TZ with office TZ alongside (R27). */
export function formatDualTimezone(
  iso: string | Date | null | undefined,
  deviceTz?: string,
  officeTz = OFFICE_DISPLAY_TZ_FALLBACK,
): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const localTz = deviceTz || Intl.DateTimeFormat().resolvedOptions().timeZone || APP_TIMEZONE;
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  if (localTz === officeTz) return fmt(localTz);
  return `${fmt(localTz)} (${fmt(officeTz)})`;
}

function clockToMinutes(clock: string): number {
  const [h, m] = clock.split(':').map((n) => Number(n) || 0);
  return h * 60 + m;
}

export const SHIFT_EDGE_MINUTES = 60;

function assignedShiftIsOvernight(shift: Pick<MyShift, 'start_time' | 'end_time' | 'crosses_midnight'>): boolean {
  if (shift.crosses_midnight) return true;
  return clockToMinutes(shift.start_time) >= clockToMinutes(shift.end_time);
}

function shiftDisplayTimezone(shift: Pick<MyShift, 'timezone'> | null | undefined): string {
  return shift?.timezone || OFFICE_DISPLAY_TZ_FALLBACK;
}

function inShiftSpan(
  shift: MyShift,
  at: Date,
  beforeMinutes: number,
  afterMinutes: number,
): boolean {
  // UI-only approximation. Server attendance_window_for_user is authoritative (R21).
  const tz = shiftDisplayTimezone(shift);
  const local = minutesInTimezone(tz, at);
  const isoDow = isoDowInTimezone(tz, at);
  const start = clockToMinutes(shift.start_time);
  const end = clockToMinutes(shift.end_time);
  const early = (start - Math.max(0, beforeMinutes) + 24 * 60) % (24 * 60);
  const late = (end + Math.max(0, afterMinutes)) % (24 * 60);
  const lateWraps = afterMinutes > 0 && late < end;
  const days = shift.days_of_week || [];
  const prevDow = isoDow === 1 ? 7 : isoDow - 1;
  const overnight = assignedShiftIsOvernight(shift) || lateWraps;

  if (!overnight) {
    if (!days.includes(isoDow)) return false;
    if (early <= start) return local >= early && local <= late;
    return local >= early || local <= late;
  }

  if (local >= early) return days.includes(isoDow);
  if (local <= late) return days.includes(prevDow);
  return false;
}

/** Check-in window: 1 hour before start through shift end. */
export function isWithinAssignedShift(shift: MyShift, at = new Date()): boolean {
  return inShiftSpan(shift, at, SHIFT_EDGE_MINUTES, 0);
}

/** Checkout window: 1 hour before start through 1 hour after end. Extra time counts if they clock it. */
export function isWithinShiftExitWindow(shift: MyShift, at = new Date()): boolean {
  return inShiftSpan(shift, at, SHIFT_EDGE_MINUTES, SHIFT_EDGE_MINUTES);
}

export function hasAssignedShiftEnded(shift: MyShift, at = new Date()): boolean {
  const tz = shiftDisplayTimezone(shift);
  const local = minutesInTimezone(tz, at);
  const isoDow = isoDowInTimezone(tz, at);
  const start = clockToMinutes(shift.start_time);
  const end = clockToMinutes(shift.end_time);
  const days = shift.days_of_week || [];

  if (!assignedShiftIsOvernight(shift)) {
    if (!days.includes(isoDow)) return true;
    return local > end;
  }
  if (local > end && local < start) return true;
  if (local >= start || local <= end) return false;
  return true;
}

/** Milliseconds until this shift's end clock in shift TZ (UI only). 0 if already ended. */
export function msUntilAssignedShiftEnd(shift: MyShift, at = new Date()): number {
  if (hasAssignedShiftEnded(shift, at)) return 0;
  const tz = shiftDisplayTimezone(shift);
  const local = minutesInTimezone(tz, at);
  const start = clockToMinutes(shift.start_time);
  const end = clockToMinutes(shift.end_time);
  let minutesLeft: number;
  if (!assignedShiftIsOvernight(shift)) {
    minutesLeft = end - local;
  } else if (local >= start) {
    minutesLeft = 24 * 60 - local + end;
  } else {
    minutesLeft = end - local;
  }
  return Math.max(0, minutesLeft) * 60_000;
}

export interface LocationWindow {
  source: 'shift' | 'company';
  shift_name: string | null;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  days_of_week: number[];
  crosses_midnight: boolean;
  in_window: boolean;
}

export function locationWindowToMyShift(window: LocationWindow): MyShift {
  return {
    shift_id: window.source,
    shift_name: window.shift_name || (window.source === 'shift' ? 'Shift' : 'Company hours'),
    start_time: window.start_time,
    end_time: window.end_time,
    grace_minutes: window.grace_minutes || 0,
    days_of_week: window.days_of_week?.length ? window.days_of_week : [1, 2, 3, 4, 5, 6, 7],
    effective_from: '',
    crosses_midnight: window.crosses_midnight,
  };
}

/** Location may be used only while the assigned shift or company window is open. */
export function shouldCaptureLocationNow(window: LocationWindow | null | undefined, at = new Date()): boolean {
  if (!window) return false;
  if (typeof window.in_window === 'boolean') return window.in_window;
  return isWithinAssignedShift(locationWindowToMyShift(window), at);
}

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
  if (!days?.length) return '—';
  return days.map((d) => DAY_LABELS[d - 1] ?? '?').join(', ');
}

export function formatWorkDuration(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return '—';
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

export function isTodayWorkDay(days: number[]): boolean {
  const isoDow = new Date().getDay() === 0 ? 7 : new Date().getDay();
  return days.includes(isoDow);
}

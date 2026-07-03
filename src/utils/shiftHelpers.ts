/** Work shift types and formatting helpers */

export interface WorkShift {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  grace_minutes: number;
  active: boolean;
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

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function formatShiftTime(t: string | null | undefined): string {
  if (!t) return '—';
  const [h, m] = t.split(':');
  const d = new Date();
  d.setHours(Number(h), Number(m), 0, 0);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

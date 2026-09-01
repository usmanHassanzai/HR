import { supabase } from '../lib/supabase';

export interface DailyWorkReport {
  id: string;
  report_date: string;
  content: string;
  submitted_at: string;
  updated_at: string;
}

export interface AdminDailyWorkReport extends DailyWorkReport {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  department_id: string | null;
  department_name: string;
}

export interface DailyReportDeptSummary {
  department_id: string | null;
  department_name: string;
  total_staff: number;
  submitted_count: number;
  manager_count: number;
  employee_count: number;
}

export function todayIsoDate(): string {
  const d = new Date();
  return toIsoDate(d.getFullYear(), d.getMonth(), d.getDate());
}

export function toIsoDate(year: number, monthIndex: number, day: number): string {
  const y = year;
  const m = String(monthIndex + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDaysIso(iso: string, delta: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + delta);
  return toIsoDate(d.getFullYear(), d.getMonth(), d.getDate());
}

export function calendarMonthLabel(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export interface CalendarDayCell {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** Sunday-start grid cells for a month (includes leading/trailing days). */
export function monthGridDays(year: number, monthIndex: number): CalendarDayCell[] {
  const first = new Date(year, monthIndex, 1);
  const last = new Date(year, monthIndex + 1, 0);
  const startPad = first.getDay();
  const totalCells = Math.ceil((startPad + last.getDate()) / 7) * 7;
  const cells: CalendarDayCell[] = [];

  for (let i = 0; i < totalCells; i += 1) {
    const dayNum = i - startPad + 1;
    const inMonth = dayNum >= 1 && dayNum <= last.getDate();
    const date = inMonth
      ? new Date(year, monthIndex, dayNum)
      : dayNum < 1
        ? new Date(year, monthIndex, dayNum)
        : new Date(year, monthIndex + 1, dayNum - last.getDate());
    cells.push({
      iso: toIsoDate(date.getFullYear(), date.getMonth(), date.getDate()),
      day: date.getDate(),
      inMonth,
    });
  }

  return cells;
}

export async function fetchAdminDailyReportDateCounts(
  year: number,
  monthIndex: number,
): Promise<Map<string, number>> {
  const start = toIsoDate(year, monthIndex, 1);
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const end = toIsoDate(year, monthIndex, lastDay);

  const { data, error } = await supabase
    .from('daily_work_reports')
    .select('report_date')
    .gte('report_date', start)
    .lte('report_date', end);

  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data || []) {
    const key = String(row.report_date).slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function formatReportDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatReportTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function submitDailyWorkReport(content: string, reportDate?: string) {
  const { data, error } = await supabase.rpc('submit_daily_work_report', {
    p_content: content,
    p_report_date: reportDate || null,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as DailyWorkReport;
}

export async function fetchMyDailyWorkReports(limit = 30): Promise<DailyWorkReport[]> {
  const { data, error } = await supabase.rpc('get_my_daily_work_reports', {
    p_limit: limit,
  });
  if (error) throw error;
  return (data as DailyWorkReport[]) || [];
}

export async function fetchAdminDailyWorkReports(opts: {
  departmentId?: string | null;
  reportDate?: string | null;
  role?: string | null;
  search?: string | null;
}): Promise<AdminDailyWorkReport[]> {
  const { data, error } = await supabase.rpc('get_admin_daily_work_reports', {
    p_department_id: opts.departmentId || null,
    p_report_date: opts.reportDate || null,
    p_role: opts.role || null,
    p_search: opts.search || null,
  });
  if (error) throw error;
  return (data as AdminDailyWorkReport[]) || [];
}

export async function fetchAdminDailyReportDeptSummary(
  reportDate?: string | null,
): Promise<DailyReportDeptSummary[]> {
  const { data, error } = await supabase.rpc('get_admin_daily_report_dept_summary', {
    p_report_date: reportDate || null,
  });
  if (error) throw error;
  return ((data as DailyReportDeptSummary[]) || []).map((row) => ({
    ...row,
    total_staff: Number(row.total_staff),
    submitted_count: Number(row.submitted_count),
    manager_count: Number(row.manager_count),
    employee_count: Number(row.employee_count),
  }));
}

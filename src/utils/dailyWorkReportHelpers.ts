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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

/**
 * KPI task categories (library grouping only).
 * Points come from assigned Score, Weight, and due date — not Achieved / Not Achieved.
 */

export const KPI_CATEGORY_IDS = [
  'monthly_goal',
  'quality',
  'punctuality_behaviour',
  'urgent_tasks',
] as const;

export type KpiCategoryId = (typeof KPI_CATEGORY_IDS)[number];

export type EmployeeProgressId = 'started' | 'completed';

export type KpiResultStatus = 'achieved' | 'not_achieved';

export const KPI_CATEGORIES: {
  id: KpiCategoryId;
  label: string;
}[] = [
  { id: 'monthly_goal', label: 'Monthly Goal' },
  { id: 'quality', label: 'Quality' },
  { id: 'punctuality_behaviour', label: 'Punctuality & Behaviour' },
  { id: 'urgent_tasks', label: 'Urgent Tasks' },
];

export const EMPLOYEE_PROGRESS_OPTIONS: { id: EmployeeProgressId; label: string }[] = [
  { id: 'started', label: 'In progress' },
  { id: 'completed', label: 'Complete' },
];

export const KPI_RESULT_OPTIONS: { id: KpiResultStatus; label: string }[] = [
  { id: 'achieved', label: 'Achieved' },
  { id: 'not_achieved', label: 'Not Achieved' },
];

export function isKpiCategoryId(value: string | null | undefined): value is KpiCategoryId {
  return !!value && (KPI_CATEGORY_IDS as readonly string[]).includes(value);
}

export function kpiCategoryMeta(id: string | null | undefined) {
  return KPI_CATEGORIES.find((c) => c.id === id) || KPI_CATEGORIES[0];
}

export function kpiResultStatus(kpi: { result_status?: string | null; manager_rating?: string | null }): KpiResultStatus | null {
  const raw = (kpi.result_status || kpi.manager_rating || '').toLowerCase();
  if (raw === 'achieved' || raw === 'good' || raw === 'always_on_time' || raw === 'on_time' || raw === 'partially_achieved' || raw === 'average' || raw === 'behaves_well') {
    return 'achieved';
  }
  if (raw === 'not_achieved' || raw === 'poor' || raw === 'always_late' || raw === 'behaves_not_good' || raw === 'late') {
    return 'not_achieved';
  }
  return null;
}

export function kpiResultLabel(kpi: { result_status?: string | null; manager_rating?: string | null }): string {
  const status = kpiResultStatus(kpi);
  if (status === 'achieved') return 'Achieved';
  if (status === 'not_achieved') return 'Not Achieved';
  return 'Pending';
}

export function employeeCanSelfMark(_category?: string | null): boolean {
  return true;
}

/** Tasks that overlap the calendar month in Asia/Karachi. */
export function kpiOverlapsCurrentMonth(
  kpi: { start_date?: string | null; end_date?: string | null; created_at?: string },
  now = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  if (!y || !m) return true;
  const monthStart = `${y}-${m}-01`;
  const last = new Date(Number(y), Number(m), 0).getDate();
  const monthEnd = `${y}-${m}-${String(last).padStart(2, '0')}`;
  const start = (kpi.start_date || kpi.created_at || monthStart).slice(0, 10);
  const end = (kpi.end_date || start).slice(0, 10);
  return start <= monthEnd && end >= monthStart;
}

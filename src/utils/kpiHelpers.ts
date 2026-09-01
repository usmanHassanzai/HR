import { calculateOverallKpiScore } from './kpiScoreHelpers';

export type UserRole = 'employee' | 'manager' | 'admin' | 'hr';

export function displayRoleLabel(role: string): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  return 'Employee';
}

export function roleNeedsDepartment(role: UserRole): boolean {
  return role === 'employee' || role === 'manager';
}
export type WorkMode = 'office' | 'remote' | 'hybrid';
export type KpiStatus = 'on_track' | 'at_risk' | 'off_track';
export type NotificationType = 'info' | 'alert' | 'reminder' | 'escalation';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  manager_id: string | null;
  health_score?: number;
  previous_health_score?: number;
  health_score_updated_at?: string;
  created_at: string;
  is_demo?: boolean;
  company_id?: string | null;
  department_id?: string | null;
  is_platform_owner?: boolean;
  demo_expires_at?: string | null;
  /** office = GPS; remote = supervisor marks; hybrid = GPS in office + remote days */
  work_mode?: WorkMode;
}

export interface Kpi {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  assignment_notes?: string | null;
  target_value: number;
  current_value: number;
  direction: 'higher_better' | 'lower_better';
  status: KpiStatus;
  weight: number;
  category: string | null;
  kpi_category?: string | null;
  employee_progress?: 'started' | 'completed' | null;
  manager_rating?: string | null;
  assigned_score?: number | null;
  result_status?: 'achieved' | 'not_achieved' | null;
  department?: string | null;
  department_id?: string | null;
  indicator_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  completion_status?: 'pending' | 'completed';
  supervisor_score_pct?: number | null;
  last_edited_by_name?: string | null;
  last_edited_by_role?: string | null;
  last_edited_at?: string | null;
  viewed_at?: string | null;
  viewed_by?: string | null;
  completed_at?: string | null;
  paused_at?: string | null;
  pause_days?: number | null;
  paused_by?: string | null;
  redo_count?: number;
  previous_value?: number | null;
  off_track_since?: string | null;
  ai_narrative?: string | null;
  ai_narrative_updated_at?: string | null;
  suggested_target?: number | null;
  updated_at: string;
  created_at: string;
}

export interface KpiSubmission {
  id: string;
  user_id: string;
  kpi_id: string;
  value: number;
  notes: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: NotificationType;
  is_read: boolean;
  created_at: string;
}

const KPI_EDIT_TIMEZONE = 'Asia/Karachi';

export function formatKpiEditTimestamp(iso?: string | null): string {
  if (!iso) return '';
  const when = new Date(iso).toLocaleString('en-GB', {
    timeZone: KPI_EDIT_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${when} PKT`;
}

export function formatKpiEditorLabel(kpi: Pick<Kpi, 'last_edited_by_name' | 'last_edited_by_role'>): string {
  const raw = (kpi.last_edited_by_role || '').toLowerCase();
  const roleLabel = raw.includes('admin') ? 'Admin' : raw.includes('hr') ? 'HR' : 'Manager';
  const name = kpi.last_edited_by_name?.trim();
  return name ? `${name} (${roleLabel})` : roleLabel;
}

export function formatKpiAssignmentChange(kpi: Pick<Kpi, 'last_edited_at' | 'last_edited_by_name' | 'last_edited_by_role'>): string | null {
  if (!kpi.last_edited_at) return null;
  return `${formatKpiEditorLabel(kpi)} changed this task on ${formatKpiEditTimestamp(kpi.last_edited_at)}`;
}

export function isKpiViewedByAssignee(kpi: Pick<Kpi, 'user_id' | 'viewed_at' | 'viewed_by'>): boolean {
  return Boolean(kpi.viewed_at && kpi.viewed_by && kpi.viewed_by === kpi.user_id);
}

export function isKpiPaused(kpi: Pick<Kpi, 'paused_at' | 'completion_status'>): boolean {
  return Boolean(kpi.paused_at) && kpi.completion_status !== 'completed';
}

export type KpiWorkStage = 'not_started' | 'in_progress' | 'complete';

function karachiYmd(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KPI_EDIT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

/** Calendar days already applied, plus the current pause if it is still on. */
export function kpiPausedDaysTotal(kpi: Pick<Kpi, 'pause_days' | 'paused_at'>, now = new Date()): number {
  const stored = Math.max(0, Number(kpi.pause_days) || 0);
  if (!kpi.paused_at) return stored;
  const from = karachiYmd(kpi.paused_at);
  const to = karachiYmd(now);
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const extra = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400000)) : 0;
  return stored + extra;
}

export function kpiPauseLabel(kpi: Pick<Kpi, 'pause_days' | 'paused_at' | 'end_date'>): string {
  const days = kpiPausedDaysTotal(kpi);
  if (kpi.paused_at) {
    return days === 1 ? 'Paused · 1 day so far' : `Paused · ${days} days so far`;
  }
  if (days <= 0) return '';
  return days === 1 ? 'Due date extended by 1 paused day' : `Due date extended by ${days} paused days`;
}

/** Email or assignment does not start work. Opening the task in Scorr does. */
export function kpiWorkStage(
  kpi: Pick<Kpi, 'user_id' | 'viewed_at' | 'viewed_by' | 'employee_progress' | 'completion_status' | 'paused_at'>,
): KpiWorkStage {
  if (kpi.completion_status === 'completed' || kpi.employee_progress === 'completed') return 'complete';
  if (kpi.paused_at) return 'in_progress';
  if (kpi.employee_progress === 'started' || isKpiViewedByAssignee(kpi)) return 'in_progress';
  return 'not_started';
}

export function kpiWorkStageLabel(stage: KpiWorkStage): string {
  if (stage === 'complete') return 'Complete';
  if (stage === 'in_progress') return 'In progress';
  return 'Not started';
}

export function kpiHealthLabel(status: string): string {
  if (status === 'on_track' || status === 'completed') return 'Going well';
  if (status === 'at_risk') return 'Needs attention';
  return 'Behind';
}

export function kpiProgressBadge(kpi: Pick<Kpi, 'user_id' | 'viewed_at' | 'viewed_by' | 'employee_progress' | 'completion_status' | 'status' | 'paused_at' | 'pause_days' | 'end_date'>): {
  light: 'green' | 'yellow' | 'red' | 'gray';
  label: string;
} {
  if (kpi.paused_at && kpi.completion_status !== 'completed') {
    return { light: 'yellow', label: 'Paused' };
  }
  const stage = kpiWorkStage(kpi);
  if (stage === 'complete') return { light: 'green', label: 'Complete' };
  if (stage === 'not_started') return { light: 'gray', label: 'Not started' };
  const light = kpi.status === 'on_track' ? 'green' : kpi.status === 'at_risk' ? 'yellow' : 'red';
  return { light, label: `In progress · ${kpiHealthLabel(kpi.status)}` };
}

export function formatKpiViewedAt(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    timeZone: KPI_EDIT_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Calculates the status of a KPI card client-side.
 */
export function calculateKpiStatus(
  direction: 'higher_better' | 'lower_better',
  target: number,
  current: number
): KpiStatus {
  if (target === 0) return 'on_track';

  const ratio = current / target;

  if (direction === 'higher_better') {
    if (ratio >= 1.0) return 'on_track';
    if (ratio >= 0.85) return 'at_risk';
    return 'off_track';
  } else {
    if (ratio <= 1.0) return 'on_track';
    if (ratio <= 1.15) return 'at_risk';
    return 'off_track';
  }
}

/**
 * Overall KPI Score = SUM(Employee Score % × Weight). Same formula as dashboards and reports.
 */
export function calculateHealthScore(kpis: Kpi[]): number {
  return calculateOverallKpiScore(kpis);
}

/** Returns trend direction comparing persisted health scores. */
export function getHealthTrend(
  current?: number,
  previous?: number
): 'up' | 'down' | 'flat' {
  if (current == null || previous == null) return 'flat';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

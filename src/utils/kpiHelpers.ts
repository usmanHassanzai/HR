import { calculateOverallKpiScore } from './kpiScoreHelpers';

export type UserRole = 'employee' | 'manager' | 'admin';
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
}

export interface Kpi {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  target_value: number;
  current_value: number;
  direction: 'higher_better' | 'lower_better';
  status: KpiStatus;
  weight: number;
  category: string | null;
  department?: string | null;
  department_id?: string | null;
  indicator_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  completion_status?: 'pending' | 'completed';
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

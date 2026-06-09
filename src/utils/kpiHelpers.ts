export type UserRole = 'employee' | 'manager' | 'admin';
export type KpiStatus = 'on_track' | 'at_risk' | 'off_track';
export type TaskStatus = 'pending' | 'in_progress' | 'done';
export type NotificationType = 'info' | 'alert' | 'reminder' | 'escalation';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  manager_id: string | null;
  created_at: string;
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

export interface Task {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  due_date: string | null;
  updated_at: string;
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
 * Computes a weighted overall health score (0-100) based on KPI statuses and weights.
 */
export function calculateHealthScore(kpis: Kpi[]): number {
  if (!kpis || kpis.length === 0) return 100;

  let totalPoints = 0;
  let totalWeight = 0;

  for (const kpi of kpis) {
    let points = 0;
    if (kpi.status === 'on_track') points = 100;
    else if (kpi.status === 'at_risk') points = 50;
    else if (kpi.status === 'off_track') points = 0;

    totalPoints += points * kpi.weight;
    totalWeight += kpi.weight;
  }

  if (totalWeight === 0) return 100;

  return Math.round(totalPoints / totalWeight);
}

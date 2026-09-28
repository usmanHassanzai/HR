import type { UserRole } from './kpiHelpers';

export type NotificationDestRole = 'admin' | 'manager' | 'employee';

export type NotificationNavTarget = {
  role: NotificationDestRole;
  tab: string;
  /** Optional hint for boards that support deeper filters. */
  search?: string;
};

function titleOf(notification: { title?: string | null; message?: string | null }): string {
  return `${notification.title || ''} ${notification.message || ''}`.toLowerCase();
}

function includesAny(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

/** Map a notification to the dashboard tab it belongs to for the viewer’s role. */
export function resolveNotificationNav(
  notification: { title?: string | null; message?: string | null },
  role: UserRole | string | null | undefined,
): NotificationNavTarget | null {
  const text = titleOf(notification);
  const r = (role || 'employee').toLowerCase();

  // Daily work reports (admin/HR review queue)
  if (includesAny(text, ['daily report'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'dailyReports' };
    if (r === 'manager') return { role: 'manager', tab: 'dailyReport' };
    return { role: 'employee', tab: 'dailyReport' };
  }

  // Leave / attendance / check-in
  if (includesAny(text, ['leave ', 'leave request', 'leave approved', 'leave rejected', 'attendance', 'check-in', 'check in', 'checked in', 'shift'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'attendance' };
    if (r === 'manager') return { role: 'manager', tab: 'attendance' };
    return { role: 'employee', tab: 'attendance' };
  }

  // Gift requests / rewards — admin & manager review queues
  if (includesAny(text, ['gift request', 'gift request submitted', 'gift request rejected'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'rewards' };
    if (r === 'manager') return { role: 'manager', tab: 'rewards' };
    return { role: 'employee', tab: 'rewards' };
  }

  // Rewards / gifts / catalog / milestones
  if (
    includesAny(text, [
      'gift',
      'reward',
      'catalog',
      'milestone',
      'redeem',
      'dinner',
      'movie',
      'surprise',
      'weightage correction',
      'monthly points',
      "you've earned",
      'team reward',
      'kpi reward',
    ])
  ) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'rewards' };
    if (r === 'manager') return { role: 'manager', tab: 'rewards' };
    return { role: 'employee', tab: 'rewards' };
  }

  // KPI ready for review (assigner / manager / admin)
  if (includesAny(text, ['ready for review'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'kpis' };
    if (r === 'manager') return { role: 'manager', tab: 'kpis' };
    return { role: 'employee', tab: 'kpis' };
  }

  // KPI approved / sent back → assignee workspace
  if (includesAny(text, ['kpi approved', 'kpi sent back', 'task paused', 'task resumed'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'kpis' };
    if (r === 'manager') return { role: 'manager', tab: 'mine' };
    return { role: 'employee', tab: 'kpis' };
  }

  // Escalations / overdue / off track
  if (includesAny(text, ['escalation', 'overdue', 'off track', 'off-track', 'team kpi', 'senior kpi'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'kpis' };
    if (r === 'manager') return { role: 'manager', tab: 'employees' };
    return { role: 'employee', tab: 'kpis' };
  }

  // New / assigned KPI tasks
  if (
    includesAny(text, [
      'new kpi',
      'kpi assigned',
      'kpi task',
      'department kpi',
      'assigned you',
      'were assigned',
      'kpi completed',
      'completed kpi',
    ])
  ) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'kpis' };
    if (r === 'manager') {
      if (includesAny(text, ['assigned to you', 'were assigned', 'new kpi assigned', 'kpi completed'])) {
        return { role: 'manager', tab: 'mine' };
      }
      return { role: 'manager', tab: 'kpis' };
    }
    return { role: 'employee', tab: 'kpis' };
  }

  // MFA / security / account
  if (includesAny(text, ['authenticator', '2fa', 'backup code', 'mfa', 'password', 'security'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'settings' };
    if (r === 'manager') return { role: 'manager', tab: 'settings' };
    return { role: 'employee', tab: 'settings' };
  }

  // Company / users registration
  if (includesAny(text, ['registration', 'company approved', 'company pending', 'new user', 'account'])) {
    if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'users' };
    if (r === 'manager') return { role: 'manager', tab: 'settings' };
    return { role: 'employee', tab: 'settings' };
  }

  // Fallback: open primary workspace
  if (r === 'admin' || r === 'hr') return { role: 'admin', tab: 'users' };
  if (r === 'manager') return { role: 'manager', tab: 'mine' };
  return { role: 'employee', tab: 'kpis' };
}

export function dispatchNotificationNav(target: NotificationNavTarget): void {
  if (target.role === 'admin') {
    window.dispatchEvent(
      new CustomEvent('scorr-open-admin-tab', {
        detail: { tab: target.tab, search: target.search },
      }),
    );
    return;
  }
  if (target.role === 'manager') {
    window.dispatchEvent(
      new CustomEvent('scorr-open-manager-tab', {
        detail: { tab: target.tab, search: target.search },
      }),
    );
    return;
  }
  window.dispatchEvent(
    new CustomEvent('scorr-open-employee-tab', {
      detail: { tab: target.tab, search: target.search },
    }),
  );
}

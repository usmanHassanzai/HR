import type { UserRole } from './kpiHelpers';
import {
  parseNotificationMeta,
  parsePersonNameFromMessage,
  type NotificationMeta,
} from './notificationDeepLink';

export type NotificationDestRole = 'admin' | 'manager' | 'employee';

export type NotificationNavTarget = {
  role: NotificationDestRole;
  tab: string;
  /** Optional hint for boards that support deeper filters. */
  search?: string;
  kpiId?: string;
  userId?: string;
  leaveId?: string;
  awardId?: string;
  redemptionId?: string;
  desk?: 'assign' | 'library' | 'board';
  adminTab?: 'leave' | 'remote' | 'shifts' | 'history';
  rewardsTab?: 'board' | 'redemptions' | 'catalog' | 'awards' | 'history';
};

function titleOf(notification: { title?: string | null; message?: string | null }): string {
  return `${notification.title || ''} ${notification.message || ''}`.toLowerCase();
}

function includesAny(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

function withMeta(base: NotificationNavTarget, meta: NotificationMeta, fallbackSearch?: string): NotificationNavTarget {
  return {
    ...base,
    search: meta.search || fallbackSearch || base.search,
    kpiId: meta.kpiId || base.kpiId,
    userId: meta.userId || base.userId,
    leaveId: meta.leaveId || base.leaveId,
    awardId: meta.awardId || base.awardId,
    redemptionId: meta.redemptionId || base.redemptionId,
    desk: meta.desk || base.desk,
    adminTab: meta.adminTab || base.adminTab,
    rewardsTab: meta.rewardsTab || base.rewardsTab,
  };
}

/** Map a notification to the dashboard tab (+ entity hints) for the viewer’s role. */
export function resolveNotificationNav(
  notification: {
    title?: string | null;
    message?: string | null;
    meta?: unknown;
  },
  role: UserRole | string | null | undefined,
): NotificationNavTarget | null {
  const text = titleOf(notification);
  const r = (role || 'employee').toLowerCase();
  const meta = parseNotificationMeta(notification.meta);
  const nameFromMsg = parsePersonNameFromMessage(notification.message);

  // Daily work reports (admin/HR review queue)
  if (includesAny(text, ['daily report']) || meta.kind === 'daily_report') {
    const search = meta.search || nameFromMsg;
    if (r === 'admin' || r === 'hr') {
      return withMeta({ role: 'admin', tab: 'dailyReports', search }, meta, search);
    }
    if (r === 'manager') return withMeta({ role: 'manager', tab: 'dailyReport' }, meta);
    return withMeta({ role: 'employee', tab: 'dailyReport' }, meta);
  }

  // Leave / attendance / check-in
  if (
    meta.kind === 'leave' ||
    includesAny(text, ['leave ', 'leave request', 'leave approved', 'leave rejected', 'attendance', 'check-in', 'check in', 'checked in', 'shift'])
  ) {
    const search = meta.search || nameFromMsg;
    const adminTab = meta.adminTab || (includesAny(text, ['leave']) ? 'leave' : undefined);
    if (r === 'admin' || r === 'hr') {
      return withMeta({ role: 'admin', tab: 'attendance', search, adminTab }, meta, search);
    }
    if (r === 'manager') {
      return withMeta({ role: 'manager', tab: 'attendance', search, adminTab: 'leave' }, meta, search);
    }
    return withMeta({ role: 'employee', tab: 'attendance' }, meta);
  }

  // Gift requests / rewards — admin & manager review queues
  if (includesAny(text, ['gift request', 'gift request submitted', 'gift request rejected']) || meta.kind === 'award') {
    const search = meta.search || nameFromMsg;
    const rewardsTab = meta.rewardsTab || 'awards';
    if (r === 'admin' || r === 'hr') {
      return withMeta({ role: 'admin', tab: 'rewards', search, rewardsTab }, meta, search);
    }
    if (r === 'manager') {
      return withMeta({ role: 'manager', tab: 'rewards', search, rewardsTab }, meta, search);
    }
    return withMeta({ role: 'employee', tab: 'rewards', rewardsTab }, meta);
  }

  // Catalog redemptions
  if (meta.kind === 'redemption' || includesAny(text, ['catalog reward'])) {
    const rewardsTab = meta.rewardsTab || 'redemptions';
    if (r === 'admin' || r === 'hr') {
      return withMeta({ role: 'admin', tab: 'rewards', rewardsTab }, meta);
    }
    if (r === 'manager') return withMeta({ role: 'manager', tab: 'rewards', rewardsTab }, meta);
    return withMeta({ role: 'employee', tab: 'rewards', rewardsTab }, meta);
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
    if (r === 'admin' || r === 'hr') return withMeta({ role: 'admin', tab: 'rewards' }, meta);
    if (r === 'manager') return withMeta({ role: 'manager', tab: 'rewards' }, meta);
    return withMeta({ role: 'employee', tab: 'rewards' }, meta);
  }

  // KPI ready for review (assigner / manager / admin)
  if (includesAny(text, ['ready for review']) || (meta.kind === 'kpi' && includesAny(text, ['ready for review']))) {
    const search = meta.search || nameFromMsg;
    const desk = meta.desk || 'board';
    if (r === 'admin' || r === 'hr') {
      return withMeta({ role: 'admin', tab: 'kpis', desk, search }, meta, search);
    }
    if (r === 'manager') {
      return withMeta({ role: 'manager', tab: 'kpis', desk, search }, meta, search);
    }
    return withMeta({ role: 'employee', tab: 'kpis' }, meta);
  }

  // Weightage awarded / KPI approved / sent back → assignee workspace only
  if (
    includesAny(text, [
      'weightage awarded',
      'kpi approved',
      'kpi sent back',
      'task paused',
      'task resumed',
      'kpi task removed',
      'kpi removed',
    ])
  ) {
    if (r === 'admin' || r === 'hr') return withMeta({ role: 'admin', tab: 'kpis', desk: meta.desk || 'board' }, meta);
    if (r === 'manager') return withMeta({ role: 'manager', tab: 'mine' }, meta);
    return withMeta({ role: 'employee', tab: 'kpis' }, meta);
  }

  // Escalations / overdue / off track
  if (includesAny(text, ['escalation', 'overdue', 'off track', 'off-track', 'team kpi', 'senior kpi'])) {
    if (r === 'admin' || r === 'hr') return withMeta({ role: 'admin', tab: 'kpis' }, meta);
    if (r === 'manager') return withMeta({ role: 'manager', tab: 'employees' }, meta);
    return withMeta({ role: 'employee', tab: 'kpis' }, meta);
  }

  // New / assigned KPI tasks
  if (
    meta.kind === 'kpi' ||
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
    if (r === 'admin' || r === 'hr') {
      return withMeta({ role: 'admin', tab: 'kpis', desk: meta.desk || 'board' }, meta);
    }
    if (r === 'manager') {
      if (includesAny(text, ['assigned to you', 'were assigned', 'new kpi assigned', 'kpi completed', 'kpi approved', 'kpi sent back'])) {
        return withMeta({ role: 'manager', tab: 'mine' }, meta);
      }
      return withMeta({ role: 'manager', tab: 'kpis', desk: meta.desk || 'board' }, meta);
    }
    return withMeta({ role: 'employee', tab: 'kpis' }, meta);
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
  const detail = {
    tab: target.tab,
    search: target.search,
    kpiId: target.kpiId,
    userId: target.userId,
    leaveId: target.leaveId,
    awardId: target.awardId,
    redemptionId: target.redemptionId,
    desk: target.desk,
    adminTab: target.adminTab,
    rewardsTab: target.rewardsTab,
  };
  if (target.role === 'admin') {
    window.dispatchEvent(new CustomEvent('scorr-open-admin-tab', { detail }));
    return;
  }
  if (target.role === 'manager') {
    window.dispatchEvent(new CustomEvent('scorr-open-manager-tab', { detail }));
    return;
  }
  window.dispatchEvent(new CustomEvent('scorr-open-employee-tab', { detail }));
}

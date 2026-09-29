/** Scroll to and briefly highlight an element tagged with data-nav-id. */
export function scrollNavTarget(id: string | null | undefined, opts?: { retries?: number }): void {
  const target = (id || '').trim();
  if (!target || typeof document === 'undefined') return;
  const retries = opts?.retries ?? 12;

  const tryScroll = (left: number) => {
    const el = document.querySelector(`[data-nav-id="${CSS.escape(target)}"]`) as HTMLElement | null;
    if (el) {
      el.classList.add('scorr-nav-target');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => el.classList.remove('scorr-nav-target'), 4500);
      return;
    }
    if (left <= 0) return;
    window.setTimeout(() => tryScroll(left - 1), 180);
  };

  requestAnimationFrame(() => tryScroll(retries));
}

export type NotificationMeta = {
  kind?: string;
  kpiId?: string;
  userId?: string;
  leaveId?: string;
  awardId?: string;
  redemptionId?: string;
  reportId?: string;
  search?: string;
  desk?: 'assign' | 'library' | 'board';
  adminTab?: 'leave' | 'remote' | 'shifts' | 'history';
  rewardsTab?: 'board' | 'redemptions' | 'catalog' | 'awards' | 'history';
};

/** Normalize jsonb / object / string meta from notifications rows. */
export function parseNotificationMeta(raw: unknown): NotificationMeta {
  if (!raw) return {};
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else {
    return {};
  }

  const str = (k: string) => {
    const v = obj[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };

  const desk = str('desk');
  const adminTab = str('adminTab');
  const rewardsTab = str('rewardsTab');

  return {
    kind: str('kind'),
    kpiId: str('kpiId') || str('kpi_id'),
    userId: str('userId') || str('user_id'),
    leaveId: str('leaveId') || str('leave_id'),
    awardId: str('awardId') || str('award_id'),
    redemptionId: str('redemptionId') || str('redemption_id'),
    reportId: str('reportId') || str('report_id'),
    search: str('search'),
    desk: desk === 'assign' || desk === 'library' || desk === 'board' ? desk : undefined,
    adminTab:
      adminTab === 'leave' || adminTab === 'remote' || adminTab === 'shifts' || adminTab === 'history'
        ? adminTab
        : undefined,
    rewardsTab:
      rewardsTab === 'board' ||
      rewardsTab === 'redemptions' ||
      rewardsTab === 'catalog' ||
      rewardsTab === 'awards' ||
      rewardsTab === 'history'
        ? rewardsTab
        : undefined,
  };
}

/** Pull a person name from common notification message shapes (legacy rows without meta). */
export function parsePersonNameFromMessage(message?: string | null): string | undefined {
  const m = (message || '').trim();
  if (!m) return undefined;

  // "Alice (Employee) submitted a daily report…" / "Alice (Manager) updated…"
  let match = m.match(/^(.+?)\s+\((?:Employee|Manager|HR|Admin)\)\s+/i);
  if (match?.[1]) return match[1].trim();

  // "Alice requested annual leave…" / "Alice submitted KPI for review…"
  match = m.match(/^(.+?)\s+(?:requested|submitted)\b/i);
  if (match?.[1] && match[1].length < 80) return match[1].trim();

  // "Gift request: Alice"
  match = m.match(/^Gift request:\s*(.+)$/i);
  if (match?.[1]) return match[1].trim();

  return undefined;
}

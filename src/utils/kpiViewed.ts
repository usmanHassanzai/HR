import { supabase } from '../lib/supabase';

export type MarkKpisViewedResult = {
  ok: boolean;
  count: number;
  error?: string;
};

/** Persist “opened in Scorr” for the signed-in assignee. Returns ok only when the RPC succeeds. */
export async function markAssignedKpisViewed(kpiIds?: string[]): Promise<MarkKpisViewedResult> {
  const ids = (kpiIds || []).filter(Boolean);
  const { data, error } = await supabase.rpc('mark_assigned_kpis_viewed', {
    p_kpi_ids: ids.length ? ids : null,
  });
  if (error) {
    console.warn('Could not mark KPI tasks as viewed:', error.message);
    return { ok: false, count: 0, error: error.message };
  }
  return { ok: true, count: typeof data === 'number' ? data : Number(data) || 0 };
}

/**
 * Mark one assignment opened by the assignee (View task / opening the card).
 * No-ops when the signed-in user is not the assignee.
 */
export async function markKpiViewedByAssignee(
  kpiId: string,
  assigneeUserId: string,
): Promise<MarkKpisViewedResult> {
  if (!kpiId || !assigneeUserId) {
    return { ok: false, count: 0, error: 'Missing kpi or assignee' };
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid || uid !== assigneeUserId) {
    return { ok: true, count: 0 };
  }
  return markAssignedKpisViewed([kpiId]);
}

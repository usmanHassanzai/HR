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

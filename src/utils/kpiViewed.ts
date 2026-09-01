import { supabase } from '../lib/supabase';

export async function markAssignedKpisViewed(kpiIds?: string[]): Promise<void> {
  const ids = (kpiIds || []).filter(Boolean);
  const { error } = await supabase.rpc('mark_assigned_kpis_viewed', {
    p_kpi_ids: ids.length ? ids : null,
  });
  if (error) {
    console.warn('Could not mark KPI tasks as viewed:', error.message);
  }
}

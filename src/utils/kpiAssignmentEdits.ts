import { supabase } from '../lib/supabase';
import { Kpi } from './kpiHelpers';

type EditRow = {
  kpi_id: string;
  editor_name?: string | null;
  editor_role?: string | null;
  editor_id?: string | null;
  created_at: string;
};

export async function hydrateKpiLastEdits(kpis: Kpi[]): Promise<Kpi[]> {
  if (!kpis.length) return kpis;

  const { data } = await supabase
    .from('kpi_assignment_edits')
    .select('kpi_id, editor_name, editor_role, editor_id, created_at')
    .in('kpi_id', kpis.map((k) => k.id))
    .order('created_at', { ascending: false });

  const latest = new Map<string, EditRow>();
  for (const row of (data || []) as EditRow[]) {
    if (!latest.has(row.kpi_id)) latest.set(row.kpi_id, row);
  }

  const needIds = [...new Set(
    [...latest.values()]
      .filter((row) => !row.editor_name && row.editor_id)
      .map((row) => row.editor_id as string),
  )];

  const names = new Map<string, { name: string; role: string }>();
  if (needIds.length) {
    const { data: users } = await supabase.from('users').select('id, full_name, role').in('id', needIds);
    for (const user of users || []) {
      names.set(user.id, {
        name: user.full_name,
        role: user.role === 'admin' ? 'Admin' : 'Manager',
      });
    }
  }

  return kpis.map((kpi) => {
    const row = latest.get(kpi.id);
    const fromUser = row?.editor_id ? names.get(row.editor_id) : undefined;
    return {
      ...kpi,
      last_edited_at: kpi.last_edited_at || row?.created_at || null,
      last_edited_by_name: kpi.last_edited_by_name || row?.editor_name || fromUser?.name || null,
      last_edited_by_role: kpi.last_edited_by_role || row?.editor_role || fromUser?.role || null,
    };
  });
}

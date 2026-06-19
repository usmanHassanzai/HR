/** Backfill department + dates on existing KPIs (no DB reset) */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

async function sql(q) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 500));
  return body;
}

const backfill = `
UPDATE public.kpis SET
  department = COALESCE(department, category, name),
  start_date = COALESCE(start_date, (created_at::DATE)),
  end_date = COALESCE(end_date, (created_at::DATE + INTERVAL '30 days')),
  completion_status = COALESCE(completion_status, 'pending'::kpi_completion_status),
  redo_count = COALESCE(redo_count, 0)
WHERE department IS NULL OR start_date IS NULL OR end_date IS NULL;

UPDATE public.kpis SET status = 'on_track', current_value = 100
WHERE completion_status = 'completed' AND status != 'on_track';
`;

async function main() {
  console.log('Backfilling KPI dates...');
  await sql(backfill);
  const n = await sql(`SELECT count(*)::int AS n FROM public.kpis WHERE start_date IS NOT NULL`);
  console.log('Done. KPIs with dates:', n?.[0]?.n ?? n);
}
main().catch((e) => { console.error(e); process.exit(1); });

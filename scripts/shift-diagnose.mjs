/** Diagnose shift RPC / tables on Supabase */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 600));
  return body;
}

console.log('Checking shift setup...\n');

const tables = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('work_shifts', 'employee_shift_assignments');
`);
console.log('Tables:', tables);

const fns = await query(`
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('upsert_work_shift', 'get_manager_shifts', 'assign_shift_to_all_team')
  ORDER BY p.proname, args;
`);
console.log('\nFunctions:', fns);

const cols = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'work_shifts'
  ORDER BY ordinal_position;
`);
console.log('\nwork_shifts columns:', cols);

const count = await query(`SELECT COUNT(*)::int AS n FROM public.work_shifts;`);
console.log('\nSaved shifts:', count);

console.log('\nIf upsert_work_shift lacks boolean args, run:');
console.log('  cd ~/walfia.ai && node scripts/shift-attendance-migration.mjs');

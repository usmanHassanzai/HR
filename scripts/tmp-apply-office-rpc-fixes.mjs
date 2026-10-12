/** One-shot: apply fixed office migrations + verify RPCs. Do not push. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const FILES = [
  'office_radius_all_employees_2026-10-12.sql',
  'office_multi_locations_assign_2026-10-12.sql',
  'assignment_driven_location_shift_2026-10-12.sql',
  'office_delete_cascade_assignments_2026-10-12.sql',
];

async function q(sql, { readOnly = false, label = 'query' } = {}) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 1200)}`);
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && (body.message || body.error || body.code)) {
    throw new Error(`${label}: ${JSON.stringify(body).slice(0, 1200)}`);
  }
  return body;
}

async function runMigration(filename) {
  const full = path.join(__dirname, `../supabase/migrations/${filename}`);
  const SQL = fs.readFileSync(full, 'utf8');
  await q(SQL, { label: filename });
  console.log(`✅ ${filename}`);
}

console.log(`Applying office RPC fixes to ${REF}…\n`);

for (const file of FILES) {
  try {
    await runMigration(file);
  } catch (e) {
    console.error(`❌ ${file}: ${e.message?.slice(0, 500)}`);
    process.exit(1);
  }
}

console.log('\nVerifying RPCs…');

const verifySql = `
SELECT
  p.proname AS name,
  pg_get_function_result(p.oid) AS result,
  pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_offices',
    'upsert_office',
    'sync_work_sites_to_office',
    'get_employee_work_sites',
    'get_work_sites_for_user',
    'upsert_office_location'
  )
ORDER BY p.proname, args;
`;

const rows = await q(verifySql, { readOnly: true, label: 'verify' });
console.log(JSON.stringify(rows, null, 2));

const byName = Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [r.name + '(' + r.args + ')', r]));
const checks = [
  ['sync_work_sites_to_office', (r) => /integer/i.test(r?.result || '')],
  ['get_employee_work_sites', (r) => /office_location_id/i.test(r?.result || '') && /office_id/i.test(r?.result || '')],
  ['get_offices', (r) => !!r],
  ['upsert_office', (r) => !!r],
];

let ok = true;
for (const [name, test] of checks) {
  const match = Object.entries(byName).find(([k]) => k.startsWith(name + '('));
  const row = match?.[1];
  if (!row || !test(row)) {
    console.error(`❌ verify failed: ${name}`, row || 'missing');
    ok = false;
  } else {
    console.log(`✅ verify ${name}: ${row.result}`);
  }
}

if (!ok) process.exit(1);
console.log('\n✅ Office RPC fixes applied and verified');

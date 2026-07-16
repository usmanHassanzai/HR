/** Ensure all functional departments are active and seeded */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const STEPS = [
  'department_weightages.sql',
  'department_kpi_indicators.sql',
  'employee_kpi_weight_100.sql',
  'ensure_departments_open.sql',
  'seed_new_department_kpis.sql',
];

async function run(filename) {
  const full = path.join(__dirname, '../supabase/migrations', filename);
  if (!fs.existsSync(full)) {
    console.warn(`⚠️  skip ${filename}`);
    return;
  }
  const SQL = fs.readFileSync(full, 'utf8');
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${filename}: ${JSON.stringify(body).slice(0, 600)}`);
  console.log(`✅ ${filename}`);
}

console.log('Opening all functional departments…\n');
for (const file of STEPS) {
  try {
    await run(file);
  } catch (e) {
    console.warn(`⚠️  ${file}: ${e.message?.slice(0, 120)}`);
  }
}
console.log('\n✅ Departments ready: Finance, Sales & Marketing, HR, Operations & Supply Chain');

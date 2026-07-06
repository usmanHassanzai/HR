/** Apply all feature migrations (shifts + departments) */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const MIGRATIONS = [
  'shift_attendance.sql',
  'shift_attendance_v2.sql',
  'shift_attendance_v2_fix.sql',
  'department_weightages.sql',
  'kpi_assign_manual_weight.sql',
];

async function runMigration(filename) {
  const SQL = fs.readFileSync(path.join(__dirname, `../supabase/migrations/${filename}`), 'utf8');
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${filename}: ${JSON.stringify(body).slice(0, 800)}`);
  console.log(`✅ ${filename}`);
}

console.log('Applying Scorr migrations (shifts, attendance, departments)…\n');

for (const file of MIGRATIONS) {
  const full = path.join(__dirname, `../supabase/migrations/${file}`);
  if (!fs.existsSync(full)) {
    console.warn(`⚠️  skip ${file} (not found)`);
    continue;
  }
  try {
    await runMigration(file);
  } catch (e) {
    console.warn(`⚠️  ${file}: ${e.message?.slice(0, 150)}`);
  }
}

console.log('\n✅ Migration pass complete');

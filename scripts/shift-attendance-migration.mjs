/** Apply shift management migrations (v1 + v2 + fix) */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

async function runMigration(filename) {
  const SQL = fs.readFileSync(path.join(__dirname, `../supabase/migrations/${filename}`), 'utf8');
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${filename}: ${JSON.stringify(body).slice(0, 800)}`);
  console.log(`✅ ${filename} applied`);
}

for (const file of ['shift_attendance.sql', 'shift_attendance_v2.sql', 'shift_attendance_v2_fix.sql']) {
  try {
    await runMigration(file);
  } catch (e) {
    console.warn(`⚠️  ${file}:`, e.message?.slice(0, 120));
  }
}
console.log('✅ Shift attendance migrations done');

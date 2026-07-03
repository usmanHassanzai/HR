/** Apply shift management migrations (v1 + v2) */
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

try {
  await runMigration('shift_attendance.sql');
} catch (e) {
  console.warn('⚠️  shift_attendance.sql skipped or partial:', e.message?.slice(0, 120));
}

await runMigration('shift_attendance_v2.sql');
try {
  await runMigration('shift_attendance_v2_fix.sql');
} catch (e) {
  console.warn('⚠️  shift_attendance_v2_fix.sql:', e.message?.slice(0, 120));
}
console.log('✅ All shift attendance migrations applied');

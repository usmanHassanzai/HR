/** Apply auto equal department weights migration */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();
const SQL = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/auto_equal_department_weights.sql'),
  'utf8',
);

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: SQL }),
});

const body = await res.json();
if (!res.ok) {
  console.error('Failed:', JSON.stringify(body, null, 2).slice(0, 2000));
  process.exit(1);
}

console.log('✅ Department auto-weight migration applied.');
console.log('   - Equal 100% split on add/delete');
console.log('   - Permanent delete from database');
console.log('   - Existing departments rebalanced');

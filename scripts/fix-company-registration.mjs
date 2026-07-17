/**
 * One-shot fix: restore platform_get_companies + auth signup trigger.
 * Run: node scripts/fix-company-registration.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();
const SQL = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/restore_platform_rpcs_and_auth_trigger.sql'),
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

console.log('✅ Company registration fix applied.');
console.log('   - platform_get_companies restored');
console.log('   - on_auth_user_created trigger restored');
console.log('   - orphaned registrations backfilled');

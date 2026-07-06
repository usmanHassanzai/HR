/** Apply department weightages migration */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(__dirname, '../supabase/migrations/department_weightages.sql'), 'utf8');
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: SQL }),
});
const body = await res.json();
if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 800));
console.log('✅ Department weightages migration applied');

/**
 * Deploy reset_authenticator edge function.
 * Run: node scripts/deploy-reset-authenticator.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAT = requireSupabasePat();
const PROJECT_REF = supabaseProjectRef();
const BASE = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
const H = { Authorization: `Bearer ${PAT}` };

const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/reset_authenticator/index.ts'), 'utf8');
const form = new FormData();
form.append(
  'metadata',
  JSON.stringify({
    name: 'reset_authenticator',
    entrypoint_path: 'index.ts',
    verify_jwt: true,
  }),
);
form.append('file', new Blob([src], { type: 'application/typescript' }), 'index.ts');

const res = await fetch(`${BASE}/functions/deploy?slug=reset_authenticator`, {
  method: 'POST',
  headers: H,
  body: form,
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(JSON.stringify(body).slice(0, 800));
  process.exit(1);
}
console.log('ok reset_authenticator deployed');

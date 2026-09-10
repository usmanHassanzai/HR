/**
 * Deploy company_registration_notify edge function (emails info@walfia.ai).
 * Run: node scripts/deploy-company-registration-notify.mjs
 * Uses existing RESEND_API_KEY project secret.
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

const src = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/company_registration_notify/index.ts'),
  'utf8',
);
const form = new FormData();
form.append(
  'metadata',
  JSON.stringify({
    name: 'company_registration_notify',
    entrypoint_path: 'index.ts',
    // Allow invoke right after signup before a session exists
    verify_jwt: false,
  }),
);
form.append('file', new Blob([src], { type: 'application/typescript' }), 'index.ts');

const res = await fetch(`${BASE}/functions/deploy?slug=company_registration_notify`, {
  method: 'POST',
  headers: H,
  body: form,
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(JSON.stringify(body).slice(0, 800));
  process.exit(1);
}
console.log('ok company_registration_notify deployed (verify_jwt=false)');

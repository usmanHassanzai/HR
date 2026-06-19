/**
 * Deploy kpi_email edge function + optional secrets via Supabase Management API.
 * Run: node scripts/deploy-kpi-email.mjs
 * Optional: RESEND_API_KEY=re_xxx node scripts/deploy-kpi-email.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Load RESEND_API_KEY from .env if present
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^RESEND_API_KEY=(.+)$/);
    if (m && !process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = m[1].trim();
    const f = line.match(/^KPI_EMAIL_FROM=(.+)$/);
    if (f && !process.env.KPI_EMAIL_FROM) process.env.KPI_EMAIL_FROM = f[1].trim();
  }
} catch { /* no .env */ }

import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const PROJECT_REF = supabaseProjectRef();
const BASE = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;

const H = { Authorization: `Bearer ${PAT}` };

async function deployFunction() {
  const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/kpi_email/index.ts'), 'utf8');
  const form = new FormData();
  form.append(
    'metadata',
    JSON.stringify({
      name: 'kpi_email',
      entrypoint_path: 'index.ts',
      verify_jwt: true,
    })
  );
  form.append('file', new Blob([src], { type: 'application/typescript' }), 'index.ts');

  const res = await fetch(`${BASE}/functions/deploy?slug=kpi_email`, {
    method: 'POST',
    headers: H,
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Deploy failed: ${JSON.stringify(body).slice(0, 500)}`);
  console.log('✅  kpi_email deployed');
  return body;
}

async function setSecrets() {
  const secrets = [];
  if (process.env.RESEND_API_KEY) {
    secrets.push({ name: 'RESEND_API_KEY', value: process.env.RESEND_API_KEY });
  }
  if (process.env.KPI_EMAIL_FROM) {
    secrets.push({ name: 'KPI_EMAIL_FROM', value: process.env.KPI_EMAIL_FROM });
  }
  if (!secrets.length) {
    console.log('ℹ️   No RESEND_API_KEY set — function deployed but emails log only until you add a key.');
    console.log('    Get free key: https://resend.com → API Keys → then run:');
    console.log('    RESEND_API_KEY=re_xxx node scripts/deploy-kpi-email.mjs');
    return;
  }
  const res = await fetch(`${BASE}/secrets`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(secrets),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Secrets failed: ${JSON.stringify(body).slice(0, 400)}`);
  console.log('✅  Secrets set:', secrets.map((s) => s.name).join(', '));
}

async function testInvoke() {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const anon = env.match(/VITE_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim();
  const url = env.match(/VITE_SUPABASE_URL=(.+)/)?.[1]?.trim();
  if (!anon || !url) return;

  const res = await fetch(`${url}/functions/v1/kpi_email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anon}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Scorr KPI email test',
      body: 'If you see this in function logs, deploy works.',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) console.log('✅  Function invoke test OK:', body);
  else console.log('⚠️   Invoke test:', res.status, body);
}

async function main() {
  console.log('\n📧  Deploy kpi_email\n' + '─'.repeat(40));
  await deployFunction();
  await setSecrets();
  await testInvoke();
  console.log('\nDone. Function URL:');
  console.log(`  https://${PROJECT_REF}.supabase.co/functions/v1/kpi_email\n`);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

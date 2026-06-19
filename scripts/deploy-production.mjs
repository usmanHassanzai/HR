/**
 * Production deploy — configure Supabase auth + build + Vercel.
 * App URL: https://scorr.walfia.ai
 *
 * Usage:
 *   node scripts/deploy-production.mjs
 *   VERCEL_TOKEN=xxx node scripts/deploy-production.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PAT = requireSupabasePat();
const PROJECT_REF = supabaseProjectRef();
const BASE = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

const PROD_URL = process.env.PROD_URL || 'https://scorr.walfia.ai';

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function configureSupabaseAuth() {
  const redirects = [
    `${PROD_URL}/**`,
    'https://walfia.ai/**',
    'https://www.walfia.ai/**',
    'http://localhost:5173/**',
    'http://localhost:4173/**',
  ];
  const res = await fetch(`${BASE}/config/auth`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({
      site_url: PROD_URL,
      uri_allow_list: redirects.join(','),
      mailer_autoconfirm: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Auth config: ${JSON.stringify(body).slice(0, 400)}`);
  console.log('✅  Supabase auth →', PROD_URL);
}

function buildApp(env) {
  console.log('🔨  Building...');
  execSync('npm run build', {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
    },
  });
  console.log('✅  Build complete → dist/');
}

function deployVercel(env) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.log('\n⚠️  No VERCEL_TOKEN — skip hosting deploy.');
    printManualSteps(env);
    return;
  }

  console.log('🚀  Deploying to Vercel...');
  const envFlags = [
    `VITE_SUPABASE_URL=${env.VITE_SUPABASE_URL}`,
    `VITE_SUPABASE_ANON_KEY=${env.VITE_SUPABASE_ANON_KEY}`,
  ].join(' ');

  execSync(
    `npx vercel deploy --prod --yes --token "${token}" ${envFlags.split(' ').map((e) => `--env ${e}`).join(' ')}`,
    { cwd: ROOT, stdio: 'inherit' }
  );
  console.log('✅  Vercel deploy done');
  printDnsSteps();
}

function printDnsSteps() {
  console.log(`
📌 DNS (at your walfia.ai registrar / Cloudflare):
   Type   Name    Value
   CNAME  scorr   cname.vercel-dns.com

   Then in Vercel → Project → Settings → Domains → add scorr.walfia.ai

   Optional: redirect walfia.ai → scorr.walfia.ai in Vercel or Cloudflare
`);
}

function printManualSteps(env) {
  console.log(`
📌 Deploy manually (pick one):

A) Vercel (recommended — vercel.json already configured):
   1. npm i -g vercel && vercel login
   2. vercel link
   3. vercel env add VITE_SUPABASE_URL production
      → ${env.VITE_SUPABASE_URL}
   4. vercel env add VITE_SUPABASE_ANON_KEY production
   5. vercel --prod
   6. Add domain scorr.walfia.ai in Vercel dashboard

B) Any static host: upload dist/ folder, set same env vars at build time

C) VPS + nginx: see deploy/nginx-scorr.conf
`);
  printDnsSteps();
}

async function main() {
  console.log('\n🌐  Scorr production deploy →', PROD_URL, '\n' + '─'.repeat(44));
  const env = loadEnv();
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('Missing VITE_SUPABASE_* in .env');
  }
  await configureSupabaseAuth();
  buildApp(env);
  deployVercel(env);
  console.log('\n✅  Production ready at', PROD_URL, '(after DNS + Vercel domain)\n');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

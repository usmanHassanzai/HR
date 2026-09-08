#!/usr/bin/env node
/**
 * Prepare Scorr for manual deployment (database + edge functions + build).
 * Does NOT publish to Vercel/GitHub — run those steps yourself after this finishes.
 *
 * Usage:
 *   node scripts/deploy-manual.mjs
 *   npm run deploy:prepare
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, label) {
  console.log(`\n▶ ${label}…`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`\n❌ Failed: ${label}`);
    process.exit(r.status ?? 1);
  }
}

console.log('🚀 Scorr — prepare for manual deploy (scorr.walfia.ai)\n');

run('node', ['scripts/apply-all-migrations.mjs'], 'Supabase migrations');
run('node', ['scripts/deploy-forgot-password.mjs'], 'Edge function: forgot_password');
run('node', ['scripts/deploy-reset-authenticator.mjs'], 'Edge function: reset_authenticator');
run('node', ['scripts/deploy-mfa-recovery.mjs'], 'Edge function: mfa_recovery');
run('node', ['scripts/deploy-kpi-email.mjs'], 'Edge function: kpi_email');
run('npm', ['run', 'build'], 'Production build');

console.log(`
✅ Backend + build ready. Publish the frontend yourself:

Option A — Git push (if Vercel is linked to GitHub):
  git push origin master:main

Option B — Vercel CLI:
  npx vercel login
  npx vercel deploy --prod --yes

Option C — Vercel prebuilt (after vercel login):
  npx vercel build --prod --yes
  npx vercel --prebuilt --prod --yes

Then hard-refresh: https://scorr.walfia.ai
`);

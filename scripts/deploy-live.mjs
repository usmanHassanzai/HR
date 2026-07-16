#!/usr/bin/env node
/**
 * Deploy everything to live: Supabase migrations → build → Vercel production
 * Run: node scripts/deploy-live.mjs
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, label) {
  console.log(`\n▶ ${label}…`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`❌ Failed: ${label}`);
    process.exit(r.status ?? 1);
  }
}

console.log('🚀 Scorr — deploy all features to live (scorr.walfia.ai)\n');

run('node', ['scripts/apply-all-migrations.mjs'], 'Supabase migrations');
run('npm', ['run', 'build'], 'Production build');
run('npx', ['vercel', 'deploy', '--prod', '--yes', '--scope', 'walfia', '--project', 'hr'], 'Vercel production deploy (hr → scorr.walfia.ai)');

console.log('\n✅ Live deploy complete → https://scorr.walfia.ai');
console.log('   Platform owner: https://scorr.walfia.ai/platform');
console.log('   Register company: landing page → Register Company');

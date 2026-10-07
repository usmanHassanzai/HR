#!/usr/bin/env node
/** Build + Vercel prod deploy. Loads VERCEL_TOKEN from .env or Vercel CLI auth.json. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function loadVercelCliToken() {
  const candidates = [
    join(homedir(), '.local/share/com.vercel.cli/auth.json'),
    join(homedir(), '.config/vercel/auth.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j.token) return String(j.token);
    } catch {
      /* ignore */
    }
  }
  return '';
}

function tokenHint() {
  return [
    'Create a token: https://vercel.com/account/tokens',
    '  Scope: team walfia (project hr → scorr.walfia.ai), then:',
    "  echo 'VERCEL_TOKEN=vercel_…' >> .env",
    '  npm run deploy:site',
    'Or: npx vercel login  (writes CLI auth; deploy-site will pick it up)',
    'If whoami fails with a bot/security challenge (X-Vercel-Mitigated), retry from',
    'a normal browser network or wait and retry — the CLI token may still be valid.',
  ].join('\n');
}

function probeApiChallenge() {
  // CLI often reports bot challenges as "token is not valid". Probe the API
  // directly so we can tell challenge vs revoked token apart.
  try {
    const r = spawnSync(
      'node',
      [
        '-e',
        `fetch('https://api.vercel.com/v2/user',{headers:{Authorization:'Bearer invalid',Accept:'application/json'}}).then(async res=>{const t=await res.text();process.stdout.write(JSON.stringify({status:res.status,mitigated:res.headers.get('x-vercel-mitigated'),body:t.slice(0,200)}));}).catch(e=>{process.stdout.write(JSON.stringify({error:String(e.message||e)}));process.exit(2);})`,
      ],
      { cwd: root, encoding: 'utf8', shell: false },
    );
    const raw = (r.stdout || '').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function probeToken(token) {
  try {
    const r = spawnSync(
      'npx',
      ['vercel', 'whoami', '--token', token],
      { cwd: root, encoding: 'utf8', env: { ...process.env, VERCEL_TOKEN: token }, shell: false },
    );
    const combined = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    return { ok: r.status === 0, status: r.status ?? 1, output: combined };
  } catch (e) {
    return { ok: false, status: 1, output: String(e?.message || e) };
  }
}

function classifyAuthFailure(output, apiProbe) {
  if (
    apiProbe?.mitigated === 'challenge' ||
    /"code"\s*:\s*"challenge"|requires a challenge/i.test(apiProbe?.body || '')
  ) {
    return 'challenge';
  }
  const text = String(output || '');
  if (/challenge|X-Vercel-Mitigated|requires a challenge|Security Checkpoint/i.test(text)) {
    return 'challenge';
  }
  if (/not valid|invalid token|unauthorized|forbidden|401|403/i.test(text)) {
    return 'invalid';
  }
  return 'unknown';
}

const fileEnv = { ...loadEnvFile(join(root, '.env')), ...loadEnvFile(join(root, '.env.local')) };
const tokenSource = process.env.VERCEL_TOKEN
  ? 'process.env'
  : fileEnv.VERCEL_TOKEN
    ? '.env'
    : loadVercelCliToken()
      ? 'vercel-cli-auth'
      : null;
const token =
  process.env.VERCEL_TOKEN || fileEnv.VERCEL_TOKEN || loadVercelCliToken() || '';

const env = {
  ...process.env,
  ...fileEnv,
  VERCEL_TOKEN: token,
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!token) {
  console.error('Missing VERCEL_TOKEN (.env or Vercel CLI login). Cannot deploy.\n' + tokenHint());
  process.exit(1);
}

// Fail fast before a full production build when auth cannot reach Vercel.
{
  const check = probeToken(token);
  if (!check.ok) {
    const apiProbe = probeApiChallenge();
    const kind = classifyAuthFailure(check.output, apiProbe);
    const detail = check.output.split('\n').filter(Boolean).pop() || 'token check failed';
    if (kind === 'challenge') {
      console.error(
        `Vercel API is challenging this network (source: ${tokenSource}).\n` +
          `${detail}\n\n` +
          'This is often misreported as an invalid token.\n' +
          'Retry later, use a different network, or deploy from a machine that can\n' +
          'complete https://api.vercel.com without a security checkpoint.\n\n' +
          tokenHint(),
      );
    } else {
      console.error(
        `VERCEL_TOKEN is not valid (source: ${tokenSource}).\n${detail}\n\n${tokenHint()}`,
      );
    }
    process.exit(1);
  }
  console.log(`Vercel auth OK (${(check.output || '').trim()} via ${tokenSource})`);
}

run('npm', ['run', 'build']);

// Prefer linked project in .vercel/; fall back to production hr → scorr.walfia.ai.
const deployArgs = ['vercel', 'deploy', 'dist', '--prod', '--yes', '--token', token];
if (existsSync(join(root, '.vercel/project.json'))) {
  // Linked project
} else {
  deployArgs.push('--scope', 'walfia', '--project', 'hr');
}
run('npx', deployArgs);
console.log('✅ Deployed → https://scorr.walfia.ai');

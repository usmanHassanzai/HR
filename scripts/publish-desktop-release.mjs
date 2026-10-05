#!/usr/bin/env node
/**
 * Publish desktop installers to a GitHub Release and print the public URLs
 * to set as Vercel env vars (VITE_DESKTOP_*_URL).
 *
 * Prerequisites:
 *   - npm run build:desktop
 *   - gh auth login
 *
 * Usage:
 *   node scripts/publish-desktop-release.mjs
 *   node scripts/publish-desktop-release.mjs --repo usmanHassanzai/HR
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUpdatedLabel, packageVersion, writeBuildInfo } from './build-info-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const downloads = join(root, 'public', 'downloads');

const repoArg = process.argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length)
  || (process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : null)
  || 'usmanHassanzai/HR';

const version = packageVersion(root);
const tag = `desktop-v${version}`;

const assets = [
  {
    file: 'Scorr-Setup.exe',
    key: 'windows',
    env: 'VITE_DESKTOP_WIN_URL',
  },
  {
    file: 'Scorr.deb',
    key: 'linuxDeb',
    env: 'VITE_DESKTOP_LINUX_DEB_URL',
  },
];

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err || `exit ${res.status}`}`);
  }
  return (res.stdout || '').trim();
}

function sizeLabel(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

console.log(`Publishing desktop ${tag} to ${repoArg}\n`);

const missing = assets.filter((a) => !existsSync(join(downloads, a.file)));
if (missing.length) {
  console.error('Missing local packages. Run: npm run build:desktop');
  for (const m of missing) console.error(`  - public/downloads/${m.file}`);
  process.exit(1);
}

try {
  run('gh', ['auth', 'status']);
} catch {
  console.error('GitHub CLI is not logged in. Run: gh auth login');
  process.exit(1);
}

// Create release if missing, then upload/replace assets.
const list = run('gh', ['release', 'list', '-R', repoArg, '--limit', '50']);
const hasTag = list.split('\n').some((line) => line.includes(tag));
if (!hasTag) {
  console.log(`Creating release ${tag}…`);
  run('gh', [
    'release',
    'create',
    tag,
    '-R',
    repoArg,
    '--title',
    `Scorr Desktop ${version}`,
    '--notes',
    `Windows zip + Linux AppImage/deb for Scorr ${version}. Unzip Windows → Scorr.exe. Linux: chmod +x Scorr.AppImage.`,
  ]);
} else {
  console.log(`Release ${tag} already exists — uploading assets…`);
}

const urls = {};
for (const asset of assets) {
  const path = join(downloads, asset.file);
  console.log(`Uploading ${asset.file}…`);
  // clobber replaces existing asset with same name
  run('gh', ['release', 'upload', tag, path, '-R', repoArg, '--clobber']);
  urls[asset.env] = `https://github.com/${repoArg}/releases/download/${tag}/${asset.file}`;
}

const exportedAt = new Date();
const platforms = {};
for (const asset of assets) {
  const bytes = statSync(join(downloads, asset.file)).size;
  platforms[asset.key] = {
    available: true,
    filename: asset.file,
    sizeBytes: bytes,
    sizeLabel: sizeLabel(bytes),
    url: urls[asset.env],
  };
}

writeBuildInfo(root, {
  desktop: {
    available: true,
    appName: 'Scorr',
    appId: 'ai.walfia.scorr.desktop',
    version,
    updatedAt: exportedAt.toISOString(),
    updatedLabel: formatUpdatedLabel(exportedAt),
    releaseTag: tag,
    releaseRepo: repoArg,
    platforms,
  },
});

console.log('\nSet these Vercel Environment Variables (Production), then redeploy:\n');
for (const [k, v] of Object.entries(urls)) {
  console.log(`  ${k}=${v}`);
}
console.log(`
Or add to .env.local and rebuild:
${Object.entries(urls).map(([k, v]) => `${k}=${v}`).join('\n')}

Download page will use these absolute URLs.
`);

// Persist for local convenience
try {
  const envPath = join(root, '.env.desktop-urls');
  const body = `${Object.entries(urls).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
  writeFileSync(envPath, body);
  console.log(`Wrote ${envPath}`);
} catch {
  /* ignore */
}

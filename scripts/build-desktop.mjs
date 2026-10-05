#!/usr/bin/env node
/**
 * Build Scorr Electron installers and copy them into public/downloads/.
 *
 * Outputs:
 *   - Scorr-Setup.exe  (Windows NSIS installer — permanent install)
 *   - Scorr.deb        (Linux)
 *
 * Usage:
 *   node scripts/build-desktop.mjs
 *   node scripts/build-desktop.mjs --linux-only
 *   node scripts/build-desktop.mjs --win-only
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUpdatedLabel, packageVersion, writeBuildInfo } from './build-info-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'dist-desktop');
const downloadsDir = join(root, 'public', 'downloads');
const linuxOnly = process.argv.includes('--linux-only');
const winOnly = process.argv.includes('--win-only');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: false,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
}

function hasCmd(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 && Boolean((r.stdout || '').trim());
}

function sizeLabel(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function findArtifact(dir, matcher) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  const hit = files.find((f) => matcher(f));
  return hit ? join(dir, hit) : null;
}

console.log('Scorr Desktop build\n');

const version = packageVersion(root);
try {
  const deskPkgPath = join(root, 'desktop', 'package.json');
  const deskPkg = JSON.parse(readFileSync(deskPkgPath, 'utf8'));
  if (deskPkg.version !== version) {
    deskPkg.version = version;
    writeFileSync(deskPkgPath, `${JSON.stringify(deskPkg, null, 2)}\n`);
    console.log(`Synced desktop/package.json version → ${version}`);
  }
} catch (err) {
  console.warn('Could not sync desktop package version:', err?.message || err);
}

const electronPkg = join(root, 'node_modules', 'electron', 'package.json');
const builderPkg = join(root, 'node_modules', 'electron-builder', 'package.json');
if (!existsSync(electronPkg) || !existsSync(builderPkg)) {
  console.log('Installing electron + electron-builder…');
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'electron@37.10.3', 'electron-builder@26.15.3']);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(downloadsDir, { recursive: true });

const buildLinux = !winOnly;
const buildWin = !linuxOnly;

if (buildLinux) {
  console.log('Building Linux .deb…\n');
  run('npx', [
    'electron-builder',
    '--project',
    'desktop',
    '--config',
    'electron-builder.yml',
    '--linux',
  ]);
}

if (buildWin) {
  const wineOk = hasCmd('wine') || hasCmd('wine64');
  if (wineOk) {
    console.log('Building Windows NSIS installer (local Wine)…\n');
    run('npx', [
      'electron-builder',
      '--project',
      'desktop',
      '--config',
      'electron-builder.yml',
      '--win',
    ]);
  } else if (hasCmd('docker')) {
    console.log('Building Windows NSIS installer (Docker + Wine)…\n');
    run('docker', [
      'run',
      '--rm',
      '-e',
      'ELECTRON_CACHE=/root/.cache/electron',
      '-e',
      'ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder',
      '-v',
      `${root}:/project`,
      '-v',
      'scorr-electron-cache:/root/.cache',
      '-w',
      '/project',
      'electronuserland/builder:wine',
      'bash',
      '-lc',
      'npx electron-builder --project desktop --config electron-builder.yml --win',
    ]);
  } else {
    throw new Error(
      'Windows NSIS build needs Wine or Docker. Install one, then re-run npm run build:desktop',
    );
  }
}

const exportedAt = new Date();
const winSrc = findArtifact(outDir, (f) => /^Scorr-Setup.*\.exe$/i.test(f));
const debSrc = findArtifact(outDir, (f) => /\.deb$/i.test(f));

const desktop = {
  available: false,
  appName: 'Scorr',
  appId: 'ai.walfia.scorr.desktop',
  version,
  updatedAt: exportedAt.toISOString(),
  updatedLabel: formatUpdatedLabel(exportedAt),
  platforms: {},
};

const publish = [];

if (winSrc && existsSync(winSrc)) {
  const dest = join(downloadsDir, 'Scorr-Setup.exe');
  copyFileSync(winSrc, dest);
  const bytes = statSync(dest).size;
  desktop.platforms.windows = {
    available: true,
    filename: 'Scorr-Setup.exe',
    format: 'nsis',
    sizeBytes: bytes,
    sizeLabel: sizeLabel(bytes),
  };
  publish.push(`Windows → /downloads/Scorr-Setup.exe (${sizeLabel(bytes)})`);
  desktop.available = true;
}

if (debSrc && existsSync(debSrc)) {
  const dest = join(downloadsDir, 'Scorr.deb');
  copyFileSync(debSrc, dest);
  const bytes = statSync(dest).size;
  desktop.platforms.linuxDeb = {
    available: true,
    filename: 'Scorr.deb',
    sizeBytes: bytes,
    sizeLabel: sizeLabel(bytes),
  };
  publish.push(`Linux deb → /downloads/Scorr.deb (${sizeLabel(bytes)})`);
  desktop.available = true;
}

// Remove obsolete AppImage / zip from downloads if present
for (const stale of ['Scorr.AppImage', 'Scorr-Windows.zip']) {
  const p = join(downloadsDir, stale);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
      console.log(`Removed obsolete ${stale}`);
    } catch {
      /* ignore */
    }
  }
}

writeBuildInfo(root, { desktop });

for (const name of readdirSync(downloadsDir)) {
  if (name.endsWith('.blockmap') || name.endsWith('.yml')) {
    try {
      unlinkSync(join(downloadsDir, name));
    } catch {
      /* ignore */
    }
  }
}

console.log('\nUpdated public/downloads/build-info.json (desktop)');
if (publish.length === 0) {
  console.error('No desktop artifacts were produced.');
  process.exit(1);
}
console.log('Published:');
for (const line of publish) console.log(`  ${line}`);
console.log(`\nNext: npm run publish:desktop  (upload to GitHub Release)`);
console.log(`Version ${version}`);

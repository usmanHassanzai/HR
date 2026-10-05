#!/usr/bin/env node
/**
 * Build Scorr Electron installers and copy them into public/downloads/.
 *
 * Usage:
 *   node scripts/build-desktop.mjs
 *   node scripts/build-desktop.mjs --linux-only
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

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: false,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
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

// Keep desktop/package.json version in sync with the root app.
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

// Ensure electron + electron-builder are installed
const electronPkg = join(root, 'node_modules', 'electron', 'package.json');
const builderPkg = join(root, 'node_modules', 'electron-builder', 'package.json');
if (!existsSync(electronPkg) || !existsSync(builderPkg)) {
  console.log('Installing electron + electron-builder…');
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'electron@37.10.3', 'electron-builder@26.15.3']);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(downloadsDir, { recursive: true });

const targets = linuxOnly ? ['--linux'] : ['--linux', '--win'];
console.log(`Running electron-builder ${targets.join(' ')}…\n`);

// Build from desktop/ so only the thin Electron shell is packaged (no Vite deps).
run('npx', [
  'electron-builder',
  '--project',
  'desktop',
  '--config',
  'electron-builder.yml',
  ...targets,
]);

const exportedAt = new Date();

const winSrc =
  findArtifact(outDir, (f) => /^Scorr-Windows.*\.zip$/i.test(f)) ||
  findArtifact(outDir, (f) => /\.zip$/i.test(f) && /win/i.test(f)) ||
  findArtifact(outDir, (f) => /^Scorr.*Setup.*\.exe$/i.test(f));
const appImageSrc = findArtifact(outDir, (f) => /\.AppImage$/i.test(f));
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
  const isZip = winSrc.toLowerCase().endsWith('.zip');
  const destName = isZip ? 'Scorr-Windows.zip' : 'Scorr-Setup.exe';
  const dest = join(downloadsDir, destName);
  copyFileSync(winSrc, dest);
  const bytes = statSync(dest).size;
  desktop.platforms.windows = {
    available: true,
    filename: destName,
    format: isZip ? 'zip' : 'nsis',
    sizeBytes: bytes,
    sizeLabel: sizeLabel(bytes),
  };
  publish.push(`Windows → /downloads/${destName} (${sizeLabel(bytes)})`);
  desktop.available = true;
}

if (appImageSrc && existsSync(appImageSrc)) {
  const dest = join(downloadsDir, 'Scorr.AppImage');
  copyFileSync(appImageSrc, dest);
  try {
    // Make executable for local runs
    run('chmod', ['+x', dest]);
  } catch {
    /* ignore */
  }
  const bytes = statSync(dest).size;
  desktop.platforms.linuxAppImage = {
    available: true,
    filename: 'Scorr.AppImage',
    sizeBytes: bytes,
    sizeLabel: sizeLabel(bytes),
  };
  publish.push(`Linux AppImage → /downloads/Scorr.AppImage (${sizeLabel(bytes)})`);
  desktop.available = true;
} else {
  // electron-builder often names AppImage with version — search recursively one level
  const maybe = readdirSync(outDir).filter((f) => f.endsWith('.AppImage'));
  if (maybe[0]) {
    const dest = join(downloadsDir, 'Scorr.AppImage');
    copyFileSync(join(outDir, maybe[0]), dest);
    const bytes = statSync(dest).size;
    desktop.platforms.linuxAppImage = {
      available: true,
      filename: 'Scorr.AppImage',
      sizeBytes: bytes,
      sizeLabel: sizeLabel(bytes),
    };
    publish.push(`Linux AppImage → /downloads/Scorr.AppImage (${sizeLabel(bytes)})`);
    desktop.available = true;
  }
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

writeBuildInfo(root, { desktop });

// Drop stale blockmap / yaml noise from downloads if any were copied by mistake
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
  console.error('No desktop artifacts were produced. Check electron-builder output above.');
  process.exit(1);
}
console.log('Published:');
for (const line of publish) console.log(`  ${line}`);
console.log(`\nVersion ${version} — deploy the site to publish downloads.`);

// Touch package.json version echo for CI logs
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(`package.json version: ${pkg.version}`);
} catch {
  /* ignore */
}

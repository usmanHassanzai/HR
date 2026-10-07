#!/usr/bin/env node
/**
 * One-command Scorr release:
 *   bump → Android release APK → Win+Linux desktop → version.json feeds → deploy site
 *   (+ optional iOS cloud build trigger)
 *
 * Usage:
 *   npm run release
 *   npm run release -- --skip-android
 *   npm run release -- --skip-desktop
 *   npm run release -- --skip-deploy
 *   npm run release -- --bump-patch
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipAndroid = args.has('--skip-android');
const skipDesktop = args.has('--skip-desktop');
const skipDeploy = args.has('--skip-deploy');
const skipIos = args.has('--skip-ios') || !process.env.CODEMAGIC_TOKEN;
const bumpPatch = args.has('--bump-patch');

function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n› ${cmd} ${cmdArgs.join(' ')}\n`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: false,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function loadKeystoreEnv() {
  const envFile = join(homedir(), '.scorr', 'keystore.env');
  if (!existsSync(envFile)) return {};
  const out = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function bumpPackagePatch() {
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const parts = String(pkg.version || '0.0.0').split('.').map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  pkg.version = parts.join('.');
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Bumped package.json → ${pkg.version}`);
  return pkg.version;
}

function bumpAndroidVersionCode() {
  const gradlePath = join(root, 'android/app/build.gradle');
  let gradle = readFileSync(gradlePath, 'utf8');
  const m = gradle.match(/versionCode\s+(\d+)/);
  const next = m ? Number(m[1]) + 1 : 13;
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${next}`);
  const ver = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${ver}"`);
  writeFileSync(gradlePath, gradle);
  console.log(`Android versionCode → ${next}, versionName → ${ver}`);
  return next;
}

console.log('=== Scorr release ===');

if (bumpPatch) bumpPackagePatch();

run('node', ['scripts/ensure-android-keystore.mjs']);
const ks = loadKeystoreEnv();
Object.assign(process.env, ks);

if (!skipAndroid) {
  bumpAndroidVersionCode();
  run('node', ['scripts/build-android-apk.mjs', '--release'], { env: { ...process.env, ...ks } });
}

if (!skipDesktop) {
  run('node', ['scripts/build-desktop.mjs']);
  try {
    run('node', ['scripts/publish-desktop-release.mjs']);
  } catch (e) {
    console.warn('GitHub desktop publish failed (gh auth?). Binaries stay local.', e?.message || e);
  }
}

run('node', ['scripts/write-version-json.mjs']);

if (!skipDeploy) {
  run('node', ['scripts/deploy-site.mjs']);
}

if (!skipIos) {
  console.log('\nTriggering iOS cloud build (CODEMAGIC_TOKEN present)…');
  // Optional: Codemagic / Xcode Cloud webhook. Documented in docs/release.md.
  if (process.env.CODEMAGIC_APP_ID && process.env.CODEMAGIC_WORKFLOW_ID) {
    run('curl', [
      '-sS',
      '-X',
      'POST',
      `https://api.codemagic.io/builds`,
      '-H',
      `x-auth-token: ${process.env.CODEMAGIC_TOKEN}`,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({
        appId: process.env.CODEMAGIC_APP_ID,
        workflowId: process.env.CODEMAGIC_WORKFLOW_ID,
        branch: process.env.CODEMAGIC_BRANCH || 'main',
      }),
    ]);
  } else {
    console.log('Set CODEMAGIC_APP_ID + CODEMAGIC_WORKFLOW_ID to auto-trigger. See docs/release.md.');
  }
} else {
  console.log('\nSkipping iOS cloud build (no CODEMAGIC_TOKEN or --skip-ios).');
}

const ver = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
console.log(`
✅ Release ${ver} packaged.
  Site:     https://scorr.walfia.ai
  APK:      https://scorr.walfia.ai/downloads/scorr.apk
  Windows:  https://scorr.walfia.ai/downloads/Scorr-Setup.exe
  Linux:    https://scorr.walfia.ai/downloads/Scorr.deb
  AppImage: https://scorr.walfia.ai/downloads/Scorr.AppImage
  Manifest: https://scorr.walfia.ai/downloads/version.json
  Keystore backup: ~/Scorr-keystore-backup/
`);

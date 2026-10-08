#!/usr/bin/env node
/**
 * Writes public/downloads/version.json (+ optional desktop latest.yml stubs).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUpdatedLabel, packageVersion, readBuildInfo } from './build-info-utils.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const downloads = join(root, 'public', 'downloads');
const base = process.env.SCORR_PUBLIC_URL || 'https://scorr.walfia.ai';

function sha512File(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash('sha512').update(buf).digest('base64');
}

function androidVersionCode() {
  try {
    const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');
    const m = gradle.match(/versionCode\s+(\d+)/);
    return m ? Number(m[1]) : 12;
  } catch {
    return 12;
  }
}

function loadDesktopUrls() {
  const out = {};
  // Later files win — prefer publish output (.env.desktop-urls) over stale .env.
  for (const name of ['.env', '.env.local', '.env.desktop-urls']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^(VITE_DESKTOP_[A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const version = packageVersion(root);
const buildInfo = readBuildInfo(root);
const desktopUrls = loadDesktopUrls();

function readViteWebBuildId() {
  // dist/.web-build-id is written in Vite writeBundle with the exact define id.
  for (const rel of ['dist/.web-build-id', 'public/.web-build-id']) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const v = readFileSync(p, 'utf8').trim();
    if (v) return v;
  }
  return '';
}

// Prefer the id Vite already baked into the JS bundle (see vite.config.ts).
// Do not prefer a stale process.env.VITE_WEB_BUILD_ID over the file Vite just wrote.
const webBuildId =
  readViteWebBuildId() ||
  process.env.VITE_WEB_BUILD_ID ||
  `${version}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

const notes =
  process.env.SCORR_RELEASE_NOTES ||
  'Automatic attendance, Office Wi-Fi, 1-hour sessions, auto-updates. If install fails with a signature error, uninstall the old debug APK once, then install this release — after that, updates install over the old app.';

const apkPath = join(downloads, 'scorr.apk');
const winPath = join(downloads, 'Scorr-Setup.exe');
const debPath = join(downloads, 'Scorr.deb');
const appImagePath = join(downloads, 'Scorr.AppImage');

// Prefer .env.desktop-urls (written by publish-desktop-release) over stale .env.
const winUrl =
  desktopUrls.VITE_DESKTOP_WIN_URL ||
  process.env.VITE_DESKTOP_WIN_URL ||
  `${base}/downloads/Scorr-Setup.exe`;
const debUrl =
  desktopUrls.VITE_DESKTOP_LINUX_DEB_URL ||
  process.env.VITE_DESKTOP_LINUX_DEB_URL ||
  `${base}/downloads/Scorr.deb`;
const appImageUrl =
  desktopUrls.VITE_DESKTOP_LINUX_APPIMAGE_URL ||
  process.env.VITE_DESKTOP_LINUX_APPIMAGE_URL ||
  (existsSync(appImagePath) ? `${base}/downloads/Scorr.AppImage` : null);

const manifest = {
  generatedAt: new Date().toISOString(),
  webBuildId,
  mandatory: process.env.SCORR_UPDATE_MANDATORY === '1',
  notes,
  android: {
    versionName: version,
    versionCode: androidVersionCode(),
    apkUrl: `${base}/downloads/scorr.apk`,
    notes,
    minSupportedCode: Number(process.env.SCORR_ANDROID_MIN_CODE || 1),
    sizeBytes: existsSync(apkPath) ? statSync(apkPath).size : buildInfo.android?.sizeBytes || null,
  },
  windows: {
    version,
    setupUrl: winUrl,
    latestYmlUrl: `${base}/downloads/desktop/latest.yml`,
    notes,
  },
  linux: {
    version,
    debUrl,
    appImageUrl,
    latestYmlUrl: `${base}/downloads/desktop/latest-linux.yml`,
    notes,
  },
  ios: {
    version,
    pwaUrl: `${base}/?app=1`,
    storeUrl: process.env.SCORR_IOS_STORE_URL || null,
    notes: 'Home Screen / PWA updates with the website. Native IPA uses TestFlight or the App Store when published.',
  },
};

mkdirSync(downloads, { recursive: true });
const versionJson = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(downloads, 'version.json'), versionJson);

const desktopDir = join(downloads, 'desktop');
mkdirSync(desktopDir, { recursive: true });

let latestYml = '';
let latestLinuxYml = '';

if (existsSync(winPath)) {
  const size = statSync(winPath).size;
  const sha = sha512File(winPath);
  // Absolute URL so Vercel can host only the yml while binaries live on GitHub Releases.
  latestYml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${winUrl}`,
    `    sha512: ${sha}`,
    `    size: ${size}`,
    `path: ${winUrl}`,
    `sha512: ${sha}`,
    `releaseDate: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  writeFileSync(join(desktopDir, 'latest.yml'), latestYml);
}

if (existsSync(appImagePath) && appImageUrl) {
  const size = statSync(appImagePath).size;
  const sha = sha512File(appImagePath);
  latestLinuxYml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${appImageUrl}`,
    `    sha512: ${sha}`,
    `    size: ${size}`,
    `path: ${appImageUrl}`,
    `sha512: ${sha}`,
    `releaseDate: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  writeFileSync(join(desktopDir, 'latest-linux.yml'), latestLinuxYml);
}

const meta = {
  webBuildId,
  version,
  generatedAt: manifest.generatedAt,
  updatedLabel: formatUpdatedLabel(),
};
const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
writeFileSync(join(root, 'public', 'build-meta.json'), metaJson);

// Vercel deploys dist/ — vite copies public/ before write-version-json runs, so
// we must mirror manifests into dist or production stays on a stale webBuildId.
const distDownloads = join(root, 'dist', 'downloads');
const distDesktop = join(distDownloads, 'desktop');
mkdirSync(distDesktop, { recursive: true });
try {
  writeFileSync(join(root, 'dist', 'build-meta.json'), metaJson);
  writeFileSync(join(distDownloads, 'version.json'), versionJson);
  if (latestYml) writeFileSync(join(distDesktop, 'latest.yml'), latestYml);
  if (latestLinuxYml) writeFileSync(join(distDesktop, 'latest-linux.yml'), latestLinuxYml);
} catch (e) {
  console.warn('Could not mirror manifests into dist/', e?.message || e);
}

console.log('Wrote downloads/version.json + build-meta.json', { version, webBuildId, winUrl, appImageUrl });

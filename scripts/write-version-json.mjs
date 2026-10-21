#!/usr/bin/env node
/**
 * Writes public/downloads/version.json (+ optional desktop latest.yml stubs).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
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

// Desktop feed URLs are pinned here. Never read them from .env / .env.local /
// .env.desktop-urls — those files still point Windows at desktop-v1.3.8.
// desktop-v1.3.46 crashes on start. 1.3.47 and 1.3.48 stay pre-releases until STEP B.
// The website feed follows WINDOWS_RELEASE only. 1.3.45 is the current public feed.
const WINDOWS_RELEASE = '1.3.45';
const LINUX_RELEASE = '1.3.45';
const CRASHING_WINDOWS_RELEASES = new Set(['1.3.46']);
const WINDOWS_INSTALLERS = {
  '1.3.45': {
    sha512: '6xOC8K5GcOgSmr4RXEQ2P+VgRyTARv6NCVlQ8/glrm294xhrdedgepTw9uTrLLbAj7C77Xr3FK7/goujBkY30Q==',
    size: 92397531,
    releaseDate: '2026-10-19T20:02:31.650Z',
  },
  '1.3.48': {
    sha512: '8NwKpqnj5JefgwFKvkLSlRTPwHbuHTuEXOXGRJzAEiGVdyRk3jlO1VOa/KIXat1/jVHYhnWXjugZOMb3g3RU4A==',
    size: 92385285,
    releaseDate: '2026-10-21T16:49:33.787Z',
  },
};
const winInstaller = WINDOWS_INSTALLERS[WINDOWS_RELEASE];
if (!winInstaller) {
  console.error(`Windows feed check failed: no installer metadata for ${WINDOWS_RELEASE}`);
  process.exit(1);
}
const GH_RELEASE = 'https://github.com/usmanHassanzai/HR/releases/download';
const winUrl = `${GH_RELEASE}/desktop-v${WINDOWS_RELEASE}/Scorr-Setup.exe`;
const debUrl = `${GH_RELEASE}/desktop-v${LINUX_RELEASE}/Scorr.deb`;
const appImageUrl = `${GH_RELEASE}/desktop-v${LINUX_RELEASE}/Scorr.AppImage`;

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function versionFromDesktopUrl(url) {
  const m = String(url || '').match(/desktop-v(\d+(?:\.\d+){1,2})/);
  return m ? m[1] : '';
}

function lastPublishedWindowsRelease() {
  try {
    const r = spawnSync(
      'gh',
      ['release', 'list', '--repo', 'usmanHassanzai/HR', '--limit', '40'],
      { encoding: 'utf8' },
    );
    const found = [];
    if (r.status === 0) {
      for (const line of String(r.stdout || '').split('\n')) {
        const cols = line.split('\t');
        if (cols[1] === 'Pre-release') continue;
        const m = line.match(/desktop-v(\d+(?:\.\d+){1,2})/);
        if (m && !CRASHING_WINDOWS_RELEASES.has(m[1])) found.push(m[1]);
      }
    }
    found.sort(compareVersions);
    return found.length ? found[found.length - 1] : WINDOWS_RELEASE;
  } catch {
    return WINDOWS_RELEASE;
  }
}

function failWindowsFeed(message) {
  console.error(`Windows feed check failed: ${message}`);
  process.exit(1);
}

function assertWindowsFeed(url, feedVersion) {
  const fromUrl = versionFromDesktopUrl(url);
  const floor = lastPublishedWindowsRelease();
  if (!fromUrl) {
    failWindowsFeed(`Windows URL has no desktop-v version: ${url}`);
  }
  if (compareVersions(fromUrl, floor) < 0 || compareVersions(feedVersion, floor) < 0) {
    failWindowsFeed(
      `Windows feed ${feedVersion} (${url}) is older than the last published release ${floor}`,
    );
  }
}

const version = packageVersion(root);
const buildInfo = readBuildInfo(root);

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
const appImagePath = join(downloads, 'Scorr.AppImage');

let previousManifest = null;
try {
  previousManifest = JSON.parse(readFileSync(join(downloads, 'version.json'), 'utf8'));
} catch {
  previousManifest = null;
}

const manifest = {
  generatedAt: new Date().toISOString(),
  webBuildId,
  mandatory: process.env.SCORR_UPDATE_MANDATORY === '1',
  notes,
  android: previousManifest?.android?.versionName
    ? previousManifest.android
    : {
        versionName: version,
        versionCode: androidVersionCode(),
        apkUrl: `${base}/downloads/scorr.apk`,
        notes,
        minSupportedCode: Number(process.env.SCORR_ANDROID_MIN_CODE || 1),
        sizeBytes: existsSync(apkPath) ? statSync(apkPath).size : buildInfo.android?.sizeBytes || null,
      },
  windows: {
    version: WINDOWS_RELEASE,
    setupUrl: winUrl,
    latestYmlUrl: `${base}/downloads/desktop/latest.yml`,
    notes,
  },
  linux: {
    version: LINUX_RELEASE,
    debUrl,
    appImageUrl,
    latestYmlUrl: `${base}/downloads/desktop/latest-linux.yml`,
    notes,
  },
  ios: previousManifest?.ios?.version
    ? previousManifest.ios
    : {
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

// Installer hash and size come from WINDOWS_INSTALLERS for WINDOWS_RELEASE.
// Do not hash a different local exe, and do not read the URL from .env.
latestYml = [
  `version: ${WINDOWS_RELEASE}`,
  'files:',
  `  - url: ${winUrl}`,
  `    sha512: ${winInstaller.sha512}`,
  `    size: ${winInstaller.size}`,
  `path: ${winUrl}`,
  `sha512: ${winInstaller.sha512}`,
  `releaseDate: '${winInstaller.releaseDate}'`,
  '',
].join('\n');
writeFileSync(join(desktopDir, 'latest.yml'), latestYml);

if (existsSync(appImagePath) && appImageUrl) {
  const size = statSync(appImagePath).size;
  const sha = sha512File(appImagePath);
  latestLinuxYml = [
    `version: ${LINUX_RELEASE}`,
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

assertWindowsFeed(manifest.windows.setupUrl, manifest.windows.version);
assertWindowsFeed(winUrl, versionFromDesktopUrl(latestYml) || WINDOWS_RELEASE);

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

function syncWindowsPointers() {
  const vercelPath = join(root, 'vercel.json');
  const vercelText = readFileSync(vercelPath, 'utf8');
  const redirectPattern = /("source": "\/downloads\/Scorr-Setup\.exe",\n\s*"destination": ")[^"]+(")/;
  if (!redirectPattern.test(vercelText)) {
    failWindowsFeed('vercel.json is missing the Windows Setup redirect');
  }
  const vercelNext = vercelText.replace(redirectPattern, `$1${winUrl}$2`);
  if (!vercelNext.includes(winUrl)) {
    failWindowsFeed('vercel.json Windows redirect did not take the release-file URL');
  }
  if (vercelNext !== vercelText) writeFileSync(vercelPath, vercelNext);

  const info = readBuildInfo(root);
  info.desktop = info.desktop || {};
  info.desktop.version = WINDOWS_RELEASE;
  info.desktop.releaseTag = `desktop-v${WINDOWS_RELEASE}`;
  info.desktop.platforms = info.desktop.platforms || {};
  const winBytes = winInstaller.size;
  info.desktop.platforms.windows = {
    ...(info.desktop.platforms.windows || {}),
    available: true,
    filename: 'Scorr-Setup.exe',
    sizeBytes: winBytes,
    sizeLabel: `${(winBytes / (1024 * 1024)).toFixed(1)} MB`,
    url: winUrl,
  };
  const infoJson = `${JSON.stringify(info, null, 2)}\n`;
  writeFileSync(join(downloads, 'build-info.json'), infoJson);

  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) return;
  mkdirSync(join(distDir, 'downloads'), { recursive: true });
  writeFileSync(join(distDir, 'vercel.json'), vercelNext.endsWith('\n') ? vercelNext : `${vercelNext}\n`);
  writeFileSync(join(distDir, 'downloads', 'build-info.json'), infoJson);
}

function assertBuiltFilesOmitOldWindows() {
  const banned = ['desktop-v1.3.46', 'desktop-v1.3.47'];
  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) {
    failWindowsFeed('dist/ is missing, so the Windows URL check cannot run');
  }
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const text = readFileSync(path).toString('utf8');
      for (const token of banned) {
        if (text.includes(token)) hits.push(`${path} contains ${token}`);
      }
    }
  };
  walk(distDir);
  if (hits.length) {
    failWindowsFeed(`built files still point at an old Windows release:\n${hits.join('\n')}`);
  }
}

syncWindowsPointers();
assertBuiltFilesOmitOldWindows();

console.log('Wrote downloads/version.json + build-meta.json', {
  version,
  webBuildId,
  winUrl,
  windowsVersion: manifest.windows.version,
  appImageUrl,
});

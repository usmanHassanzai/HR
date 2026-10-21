#!/usr/bin/env node
/**
 * Writes public/downloads/version.json (+ desktop latest.yml feeds) and mirrors into dist/.
 *
 * latest.yml / latest-linux.yml MUST always be emitted — electron-updater on installed
 * desktops fetches https://scorr.walfia.ai/downloads/desktop/latest.yml. Missing feeds
 * break auto-update even when GitHub Release binaries exist.
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
const desktopDir = join(downloads, 'desktop');
const distDesktopBuilder = join(root, 'dist-desktop');

// Prefer GitHub URLs only when they match this package version (avoid stale
// desktop-v1.3.28 feeds after a newer local build). Otherwise host on the site.
function urlForThisVersion(candidate, fallback) {
  const u = String(candidate || '').trim();
  if (u && u.includes(`desktop-v${version}`)) return u;
  return fallback;
}

/** Allow Windows-only releases to keep Linux on an older desktop-v* tag. */
function urlAllowAnyDesktopTag(candidate, fallback) {
  const u = String(candidate || '').trim();
  if (u && /\/releases\/download\/desktop-v[\d.]+\//.test(u)) return u;
  return urlForThisVersion(u, fallback);
}

function versionFromDesktopUrl(url, fallback) {
  const m = String(url || '').match(/\/desktop-v([\d.]+)\//);
  return m ? m[1] : fallback;
}

function defaultGithubWin() {
  return `https://github.com/usmanHassanzai/HR/releases/download/desktop-v${version}/Scorr-Setup.exe`;
}
function defaultGithubDeb() {
  return `https://github.com/usmanHassanzai/HR/releases/download/desktop-v${version}/Scorr.deb`;
}
function defaultGithubAppImage() {
  return `https://github.com/usmanHassanzai/HR/releases/download/desktop-v${version}/Scorr.AppImage`;
}

// Windows may ship ahead of Linux; accept any desktop-v* GitHub URL from env.
const winUrl = urlAllowAnyDesktopTag(
  desktopUrls.VITE_DESKTOP_WIN_URL || process.env.VITE_DESKTOP_WIN_URL,
  existsSync(winPath) ? `${base}/downloads/Scorr-Setup.exe` : defaultGithubWin(),
);
const debUrl = urlAllowAnyDesktopTag(
  desktopUrls.VITE_DESKTOP_LINUX_DEB_URL || process.env.VITE_DESKTOP_LINUX_DEB_URL,
  existsSync(debPath) ? `${base}/downloads/Scorr.deb` : defaultGithubDeb(),
);
const appImageUrl = urlAllowAnyDesktopTag(
  desktopUrls.VITE_DESKTOP_LINUX_APPIMAGE_URL || process.env.VITE_DESKTOP_LINUX_APPIMAGE_URL,
  existsSync(appImagePath) ? `${base}/downloads/Scorr.AppImage` : defaultGithubAppImage(),
);
const linuxVersion = versionFromDesktopUrl(debUrl || appImageUrl, version);
const windowsVersion = versionFromDesktopUrl(winUrl, version);

/**
 * Read sha512/size from an existing electron-updater yml (committed feed or builder output).
 * @returns {{ sha512: string, size: number, version?: string } | null}
 */
function parseUpdaterYml(ymlPath) {
  if (!existsSync(ymlPath)) return null;
  try {
    const text = readFileSync(ymlPath, 'utf8');
    const sha = (text.match(/^\s*sha512:\s*(\S+)/m) || [])[1];
    const sizeRaw = (text.match(/^\s*size:\s*(\d+)/m) || [])[1];
    const ver = (text.match(/^version:\s*(\S+)/m) || [])[1];
    const size = sizeRaw ? Number(sizeRaw) : 0;
    if (!sha) return null;
    return { sha512: sha, size: Number.isFinite(size) ? size : 0, version: ver };
  } catch {
    return null;
  }
}

/**
 * Resolve sha/size for a desktop artifact. Prefer hashing the local file; else reuse a
 * matching committed / builder yml so deploys without huge binaries still emit feeds.
 */
function resolveArtifactMeta(localPath, ymlCandidates, expectedVersion) {
  if (localPath && existsSync(localPath)) {
    return { sha512: sha512File(localPath), size: statSync(localPath).size, from: 'file' };
  }
  for (const cand of ymlCandidates) {
    const parsed = parseUpdaterYml(cand);
    if (!parsed?.sha512) continue;
    // Prefer a yml whose version matches the feed we are writing.
    if (expectedVersion && parsed.version && parsed.version !== expectedVersion) continue;
    return { sha512: parsed.sha512, size: parsed.size || 0, from: cand };
  }
  // Last resort: any yml sha (better a slightly stale feed than a 404).
  for (const cand of ymlCandidates) {
    const parsed = parseUpdaterYml(cand);
    if (parsed?.sha512) return { sha512: parsed.sha512, size: parsed.size || 0, from: cand };
  }
  return null;
}

function buildLatestYml({ feedVersion, fileUrl, sha512, size }) {
  return [
    `version: ${feedVersion}`,
    `files:`,
    `  - url: ${fileUrl}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileUrl}`,
    `sha512: ${sha512}`,
    `releaseDate: ${new Date().toISOString()}`,
    '',
  ].join('\n');
}

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
    version: windowsVersion,
    setupUrl: winUrl,
    latestYmlUrl: `${base}/downloads/desktop/latest.yml`,
    notes,
  },
  linux: {
    version: linuxVersion,
    debUrl,
    appImageUrl,
    latestYmlUrl: `${base}/downloads/desktop/latest-linux.yml`,
    notes,
  },
  ios: {
    version,
    pwaUrl: `${base}/?app=1`,
    storeUrl: process.env.SCORR_IOS_STORE_URL || null,
    notes:
      'Home Screen / PWA updates with the website. Native IPA uses TestFlight or the App Store when published.',
  },
};

mkdirSync(downloads, { recursive: true });
const versionJson = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(downloads, 'version.json'), versionJson);

mkdirSync(desktopDir, { recursive: true });

let latestYml = '';
let latestLinuxYml = '';

const winMeta = resolveArtifactMeta(
  winPath,
  [
    join(desktopDir, 'latest.yml'),
    join(distDesktopBuilder, 'latest.yml'),
    join(downloads, 'latest.yml'),
  ],
  windowsVersion,
);
if (winMeta?.sha512) {
  latestYml = buildLatestYml({
    feedVersion: windowsVersion,
    fileUrl: winUrl,
    sha512: winMeta.sha512,
    size: winMeta.size,
  });
  writeFileSync(join(desktopDir, 'latest.yml'), latestYml);
  console.log(`Wrote desktop/latest.yml (sha from ${winMeta.from}) → ${winUrl}`);
} else {
  console.warn(
    'WARNING: could not write desktop/latest.yml (no local Setup.exe and no prior yml sha). Electron Windows auto-update will 404 until publish:desktop runs.',
  );
}

const linuxMeta = resolveArtifactMeta(
  appImagePath,
  [
    join(desktopDir, 'latest-linux.yml'),
    join(distDesktopBuilder, 'latest-linux.yml'),
    join(downloads, 'latest-linux.yml'),
  ],
  linuxVersion,
);
if (linuxMeta?.sha512 && appImageUrl) {
  latestLinuxYml = buildLatestYml({
    feedVersion: linuxVersion,
    fileUrl: appImageUrl,
    sha512: linuxMeta.sha512,
    size: linuxMeta.size,
  });
  writeFileSync(join(desktopDir, 'latest-linux.yml'), latestLinuxYml);
  console.log(`Wrote desktop/latest-linux.yml (sha from ${linuxMeta.from}) → ${appImageUrl}`);
} else {
  console.warn(
    'WARNING: could not write desktop/latest-linux.yml (no local AppImage and no prior yml sha).',
  );
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
  // Always mirror feeds when we have them — never leave production without updater yml.
  if (latestYml) writeFileSync(join(distDesktop, 'latest.yml'), latestYml);
  else if (existsSync(join(desktopDir, 'latest.yml'))) {
    writeFileSync(join(distDesktop, 'latest.yml'), readFileSync(join(desktopDir, 'latest.yml')));
  }
  if (latestLinuxYml) writeFileSync(join(distDesktop, 'latest-linux.yml'), latestLinuxYml);
  else if (existsSync(join(desktopDir, 'latest-linux.yml'))) {
    writeFileSync(
      join(distDesktop, 'latest-linux.yml'),
      readFileSync(join(desktopDir, 'latest-linux.yml')),
    );
  }
} catch (e) {
  console.warn('Could not mirror manifests into dist/', e?.message || e);
}

console.log('Wrote downloads/version.json + build-meta.json', {
  version,
  webBuildId,
  androidVersionCode: manifest.android.versionCode,
  winUrl,
  appImageUrl,
  hasLatestYml: Boolean(latestYml || existsSync(join(desktopDir, 'latest.yml'))),
  hasLatestLinuxYml: Boolean(latestLinuxYml || existsSync(join(desktopDir, 'latest-linux.yml'))),
});

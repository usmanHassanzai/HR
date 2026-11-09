#!/usr/bin/env node
/**
 * Write public/downloads/ios/manifest.plist for Ad Hoc / enterprise OTA install.
 * Requires a signed IPA at public/downloads/scorr.ipa (built on macOS).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageVersion } from './build-info-utils.mjs';

const root = new URL('..', import.meta.url).pathname;
const ipaPath = join(root, 'public', 'downloads', 'scorr.ipa');
const outDir = join(root, 'public', 'downloads', 'ios');
const outFile = join(outDir, 'manifest.plist');
const origin = (process.env.SCORR_PUBLIC_ORIGIN || 'https://scorr.walfia.ai').replace(/\/$/, '');
const version = packageVersion(root);
const bundleId = 'ai.walfia.scorr';
const title = 'Scorr';

if (!existsSync(ipaPath)) {
  console.warn('No scorr.ipa yet — skipping OTA manifest.');
  process.exit(0);
}

const ipaUrl = `${origin}/downloads/scorr.ipa`;
const iconUrl = `${origin}/icons/icon-180.png`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${ipaUrl}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>display-image</string>
          <key>url</key>
          <string>${iconUrl}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>full-size-image</string>
          <key>url</key>
          <string>${iconUrl}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${bundleId}</string>
        <key>bundle-version</key>
        <string>${version}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${title}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, plist, 'utf8');
console.log(`Wrote ${outFile} → ${ipaUrl} (v${version})`);

// Keep a tiny readme for operators
writeFileSync(
  join(outDir, 'README.md'),
  `# iOS OTA install

1. Build a **signed** Ad Hoc (or Enterprise) IPA on a Mac: \`npm run build:ios:release\`
2. Copy IPA to \`public/downloads/scorr.ipa\` and re-run this script (or the IPA build script).
3. On a registered iPhone, open Safari and tap:
   \`itms-services://?action=download-manifest&url=${encodeURIComponent(`${origin}/downloads/ios/manifest.plist`)}\`

App Store / TestFlight do not use this manifest.
`,
  'utf8',
);

// Touch build-info if IPA exists
try {
  const infoPath = join(root, 'public', 'downloads', 'build-info.json');
  if (existsSync(infoPath)) {
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    const bytes = readFileSync(ipaPath).length;
    info.ios = {
      ...(info.ios || {}),
      available: true,
      installMethod: 'ipa',
      ipaAvailable: true,
      ipaFilename: 'scorr.ipa',
      appName: title,
      appId: bundleId,
      version,
      sizeBytes: bytes,
      sizeLabel: `${(bytes / 1024 / 1024).toFixed(1)} MB`,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`);
  }
} catch {
  /* optional */
}

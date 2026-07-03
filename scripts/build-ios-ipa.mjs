#!/usr/bin/env node
/**
 * Build iOS app (Capacitor) — sync web assets; on macOS also archive/export IPA.
 *
 * Linux/Windows: web build + cap sync ios (open Xcode on Mac to finish).
 * macOS:          xcodebuild archive → export IPA → public/downloads/scorr.ipa
 *
 * Prerequisites (Mac):
 *   - Xcode + Command Line Tools (xcode-select --install)
 *   - Apple Developer account for device/TestFlight builds
 *   - Edit ios/ExportOptions.plist with your team ID
 *
 * Usage:
 *   node scripts/build-ios-ipa.mjs           # sync only (any OS)
 *   node scripts/build-ios-ipa.mjs --archive # full IPA (macOS only)
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const iosDir = join(root, 'ios', 'App');
const project = join(iosDir, 'App.xcodeproj');
const scheme = 'App';
const downloadsDir = join(root, 'public', 'downloads');
const archive = process.argv.includes('--archive');
const isMac = process.platform === 'darwin';

function run(cmd, cwd = root) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function runCapture(cmd, cwd = root) {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

console.log('Building Scorr iOS app…\n');

console.log('Step 1/4: App icons');
run('node scripts/generate-app-icons.mjs');
run('node scripts/sync-ios-icons.mjs');

console.log('\nStep 2/4: Web build + Capacitor sync (ios)');
run('npm run build');
run('npx cap sync ios');

if (!isMac) {
  console.log(`
Step 3/4: Skipped — not on macOS

iOS native builds require a Mac with Xcode.

What you can do now:
  1. iPhone users: Install via Safari → Share → Add to Home Screen (same app, no Mac needed)
  2. Push this repo and run GitHub Actions workflow "Build iOS" on macOS
  3. On a Mac: node scripts/build-ios-ipa.mjs --archive

Open in Xcode (Mac):
  npm run cap:ios
`);
  process.exit(0);
}

try {
  runCapture('xcodebuild -version');
} catch {
  console.error('\nXcode not found. Install Xcode from the Mac App Store.\n');
  process.exit(1);
}

if (!archive) {
  console.log(`
Step 3/4: Xcode project ready

  npm run cap:ios          → open in Xcode
  Product → Run            → install on connected iPhone
  Product → Archive        → TestFlight / App Store

For automated IPA export:
  node scripts/build-ios-ipa.mjs --archive
`);
  process.exit(0);
}

console.log('\nStep 3/4: Xcode archive');
const buildDir = join(iosDir, 'build');
const archivePath = join(buildDir, 'Scorr.xcarchive');
const exportDir = join(buildDir, 'ipa');
mkdirSync(buildDir, { recursive: true });

run(
  `xcodebuild -project "${project}" -scheme ${scheme} -configuration Release -destination "generic/platform=iOS" -archivePath "${archivePath}" archive`,
  iosDir,
);

console.log('\nStep 4/4: Export IPA');
const exportPlist = join(root, 'ios', 'ExportOptions.plist');
if (!existsSync(exportPlist)) {
  console.error('Missing ios/ExportOptions.plist — copy template and set teamID.');
  process.exit(1);
}

run(
  `xcodebuild -exportArchive -archivePath "${archivePath}" -exportPath "${exportDir}" -exportOptionsPlist "${exportPlist}"`,
  iosDir,
);

const ipaFiles = readdirSync(exportDir).filter((f) => f.endsWith('.ipa'));
if (ipaFiles.length === 0) {
  console.error(`No IPA in ${exportDir}. Check signing in Xcode (team + provisioning).`);
  process.exit(1);
}

const ipaSrc = join(exportDir, ipaFiles[0]);
mkdirSync(downloadsDir, { recursive: true });
const ipaDest = join(downloadsDir, 'scorr.ipa');
copyFileSync(ipaSrc, ipaDest);

const sizeMb = (readFileSync(ipaDest).length / 1024 / 1024).toFixed(1);
console.log(`
Done! IPA copied to public/downloads/scorr.ipa (${sizeMb} MB)

Note: iOS cannot install IPA from a website like Android APK.
Use one of:
  • TestFlight — upload via Xcode Organizer or App Store Connect
  • Ad Hoc — register device UDIDs in Apple Developer portal
  • App Store — submit for review

For most teams, publish TestFlight link on the website download section.
`);

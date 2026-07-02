#!/usr/bin/env node
/**
 * One-time mobile setup: sync Capacitor, verify Android SDK + Java.
 *
 * Usage: node scripts/setup-mobile.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Android', 'Sdk');

function run(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

console.log('Scorr mobile setup\n');

console.log('1/3 Building web app…');
run('npm run build');

console.log('\n2/3 Syncing Capacitor (android + ios)…');
run('npx cap sync');

console.log('\n3/3 Environment check');
const javaOk = (() => {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const sdkOk = existsSync(androidSdk);
console.log(`  Java JDK:     ${javaOk ? '✓ found' : '✗ missing — install JDK 17 (sudo apt install openjdk-17-jdk)'}`);
console.log(`  Android SDK:  ${sdkOk ? `✓ ${androidSdk}` : '✗ missing — install Android Studio or cmdline-tools'}`);

if (sdkOk && !existsSync(join(root, 'android', 'local.properties'))) {
  const props = `sdk.dir=${androidSdk.replace(/\\/g, '/')}\n`;
  import('node:fs').then(({ writeFileSync }) => {
    writeFileSync(join(root, 'android', 'local.properties'), props);
    console.log('\n  Created android/local.properties');
  });
}

console.log(`
Next steps:
  Android APK:  node scripts/build-android-apk.mjs
  Android IDE:  npm run cap:android
  iOS (Mac):    npm run cap:ios  → Xcode → Archive → App Store / TestFlight

Website download:
  After building, APK is copied to public/downloads/scorr.apk
  Deploy the site so users can download from the Mobile App section.
`);

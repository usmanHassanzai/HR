#!/usr/bin/env node
/**
 * Build Android APK and copy to public/downloads/scorr.apk for website download.
 *
 * Prerequisites:
 *   - JDK 17+  (sudo apt install openjdk-17-jdk)
 *   - Android SDK (Android Studio or cmdline-tools)
 *   - ANDROID_HOME set, or SDK at ~/Android/Sdk
 *   - Permanent release keystore: node scripts/ensure-android-keystore.mjs
 *     → ~/.scorr/scorr-release.keystore + ~/.scorr/keystore.env
 *     → backup ~/Scorr-keystore-backup/
 *
 * Usage: node scripts/build-android-apk.mjs [--release] [--skip-web]
 *   --release (default when keystore present) signs with the permanent release key.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatUpdatedLabel, packageVersion, readBuildInfo, writeBuildInfo } from './build-info-utils.mjs';

const root = new URL('..', import.meta.url).pathname;
const androidDir = join(root, 'android');
const downloadsDir = join(root, 'public', 'downloads');
const skipWeb = process.argv.includes('--skip-web');
const forceDebug = process.argv.includes('--debug');
const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Android', 'Sdk');
const localProps = join(androidDir, 'local.properties');
const portableJdk = join(root, '.tools', 'jdk-21');

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

const ksEnv = loadKeystoreEnv();
for (const [k, v] of Object.entries(ksEnv)) {
  if (!process.env[k]) process.env[k] = v;
}
function keystoreReady() {
  return (
    Boolean(process.env.SCORR_ANDROID_KEYSTORE) &&
    existsSync(process.env.SCORR_ANDROID_KEYSTORE) &&
    Boolean(process.env.SCORR_ANDROID_STORE_PASSWORD) &&
    Boolean(process.env.SCORR_ANDROID_KEY_PASSWORD)
  );
}
let release = !forceDebug && (process.argv.includes('--release') || keystoreReady());

function javaHome() {
  if (existsSync(join(portableJdk, 'bin', 'java'))) return portableJdk;
  try {
    execSync('java -version', { stdio: 'pipe' });
    return process.env.JAVA_HOME || null;
  } catch {
    return null;
  }
}

function run(cmd, cwd = root) {
  const jh = javaHome();
  const env = {
    ...process.env,
    ANDROID_HOME: androidSdk,
    ANDROID_SDK_ROOT: androidSdk,
    ...(jh ? { JAVA_HOME: jh, PATH: `${join(jh, 'bin')}:${process.env.PATH || ''}` } : {}),
  };
  execSync(cmd, { cwd, stdio: 'inherit', env });
}

function ensureJava() {
  if (javaHome()) return;
  console.log('No Java 21 found — installing portable JDK 21…');
  run('node scripts/install-portable-jdk.mjs');
  if (!javaHome()) {
    console.error('\nCould not install JDK. Run: node scripts/install-portable-jdk.mjs\n');
    process.exit(1);
  }
}

function ensureSdk() {
  if (!existsSync(androidSdk)) {
    console.error(`\nAndroid SDK not found at ${androidSdk}`);
    console.error('Install Android Studio or set ANDROID_HOME.\n');
    process.exit(1);
  }
  if (!existsSync(localProps)) {
    writeFileSync(localProps, `sdk.dir=${androidSdk.replace(/\\/g, '/')}\n`);
    console.log('Created android/local.properties');
  }

  const platform36 = join(androidSdk, 'platforms', 'android-36');
  if (!existsSync(platform36)) {
    console.log('Installing Android SDK Platform 36…');
    const sdkmanager = join(androidSdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    if (!existsSync(sdkmanager)) {
      console.error('sdkmanager not found. Install Android SDK cmdline-tools.');
      process.exit(1);
    }
    const jh = javaHome();
    const env = {
      ...process.env,
      ANDROID_HOME: androidSdk,
      ANDROID_SDK_ROOT: androidSdk,
      ...(jh ? { JAVA_HOME: jh, PATH: `${join(jh, 'bin')}:${process.env.PATH || ''}` } : {}),
    };
    execSync(`yes | "${sdkmanager}" "platforms;android-36"`, { stdio: 'inherit', env });
  }
}

console.log('Building Scorr mobile app…\n');

if (!keystoreReady() && !forceDebug) {
  console.log('Ensuring permanent release keystore…');
  run('node scripts/ensure-android-keystore.mjs');
  Object.assign(process.env, loadKeystoreEnv());
  release = process.argv.includes('--release') || keystoreReady();
}

ensureJava();
ensureSdk();

console.log('Step 1/4: App icons');
if (!skipWeb) {
  run('node scripts/generate-app-icons.mjs');
}
run('node scripts/sync-android-icons.mjs');

function stripDownloadBinariesFromWebDir() {
  for (const name of ['scorr.apk', 'scorr.ipa']) {
    const p = join(root, 'dist', 'downloads', name);
    if (existsSync(p)) unlinkSync(p);
  }
}

console.log('\nStep 2/4: Web build + Capacitor sync');
if (!skipWeb) {
  run('npm run build');
}
stripDownloadBinariesFromWebDir();
run('npx cap sync android');

const canSign = keystoreReady();
const task = release && canSign ? 'assembleRelease' : 'assembleDebug';
if (release && !canSign) {
  console.log('\nNo ~/.scorr keystore — building debug APK.');
  console.log('Run: node scripts/ensure-android-keystore.mjs\n');
} else if (canSign) {
  console.log(`\nSigning with permanent release key: ${process.env.SCORR_ANDROID_KEYSTORE}`);
}

console.log(`\nStep 3/4: Gradle ${task} (--no-daemon, no mid-build --stop)`);
// Never call `./gradlew --stop` here — concurrent APK builds racing each other
// used to kill the other process's daemon mid-flight. Prefer a one-shot JVM.
const gradleCmd =
  process.platform === 'win32'
    ? `gradlew.bat ${task} --no-daemon`
    : `./gradlew ${task} --no-daemon`;
run(gradleCmd, androidDir);

const apkName = task === 'assembleRelease' ? 'app-release.apk' : 'app-debug.apk';
const apkSrc = join(androidDir, 'app', 'build', 'outputs', 'apk', task === 'assembleRelease' ? 'release' : 'debug', apkName);

if (!existsSync(apkSrc)) {
  console.error(`\nAPK not found at ${apkSrc}`);
  process.exit(1);
}

mkdirSync(downloadsDir, { recursive: true });
const apkDest = join(downloadsDir, 'scorr.apk');
copyFileSync(apkSrc, apkDest);

const apkBytes = readFileSync(apkDest).length;
const exportedAt = new Date();
const existing = readBuildInfo(root);
writeBuildInfo(root, {
  android: {
    available: true,
    filename: 'scorr.apk',
    appName: 'Scorr',
    appId: 'ai.walfia.scorr',
    version: packageVersion(root),
    buildType: task === 'assembleRelease' ? 'release' : 'debug',
    sizeBytes: apkBytes,
    sizeLabel: `${(apkBytes / 1024 / 1024).toFixed(1)} MB`,
    updatedAt: exportedAt.toISOString(),
    updatedLabel: formatUpdatedLabel(exportedAt),
  },
  ios: existing.ios ?? {
    available: true,
    installMethod: 'pwa',
    appName: 'Scorr',
    appId: 'ai.walfia.scorr',
    version: packageVersion(root),
    updatedAt: exportedAt.toISOString(),
    updatedLabel: formatUpdatedLabel(exportedAt),
    pwaUrl: 'https://scorr.walfia.ai',
    ipaAvailable: false,
    ipaFilename: 'scorr.ipa',
  },
});
const buildInfo = readBuildInfo(root);

console.log(`\nStep 4/4: Copied to public/downloads/scorr.apk`);
console.log(`Updated public/downloads/build-info.json`);
console.log(`
Done! Users can download from your website:
  https://scorr.walfia.ai/#download-app

Deploy the site (npm run build && vercel --prod) to publish the APK.
APK size: ${buildInfo.android.sizeLabel}
`);

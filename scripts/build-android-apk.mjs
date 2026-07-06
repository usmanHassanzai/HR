#!/usr/bin/env node
/**
 * Build Android APK and copy to public/downloads/scorr.apk for website download.
 *
 * Prerequisites:
 *   - JDK 17+  (sudo apt install openjdk-17-jdk)
 *   - Android SDK (Android Studio or cmdline-tools)
 *   - ANDROID_HOME set, or SDK at ~/Android/Sdk
 *
 * Optional release signing — create android/keystore.properties:
 *   storeFile=../scorr-release.keystore
 *   storePassword=your_password
 *   keyAlias=scorr
 *   keyPassword=your_password
 *
 * Generate keystore:
 *   keytool -genkey -v -keystore scorr-release.keystore -alias scorr -keyalg RSA -keysize 2048 -validity 10000
 *
 * Usage: node scripts/build-android-apk.mjs [--release] [--skip-web]
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const androidDir = join(root, 'android');
const downloadsDir = join(root, 'public', 'downloads');
const release = process.argv.includes('--release');
const skipWeb = process.argv.includes('--skip-web');
const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Android', 'Sdk');
const localProps = join(androidDir, 'local.properties');
const keystoreProps = join(androidDir, 'keystore.properties');
const portableJdk = join(root, '.tools', 'jdk-21');

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

function patchReleaseSigning() {
  if (!release || !existsSync(keystoreProps)) return;
  const gradlePath = join(androidDir, 'app', 'build.gradle');
  let gradle = readFileSync(gradlePath, 'utf8');
  if (gradle.includes('signingConfigs')) return;

  const signingBlock = `
    signingConfigs {
        release {
            def keystorePropertiesFile = rootProject.file("keystore.properties")
            def keystoreProperties = new Properties()
            keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
        }
    }`;

  gradle = gradle.replace(
    'buildTypes {',
    `${signingBlock}\n    buildTypes {`
  );
  gradle = gradle.replace(
    'release {\n            minifyEnabled false',
    'release {\n            signingConfig signingConfigs.release\n            minifyEnabled false'
  );
  writeFileSync(gradlePath, gradle);
  console.log('Applied release signing from keystore.properties');
}

console.log('Building Scorr mobile app…\n');

ensureJava();
ensureSdk();

console.log('Step 1/4: App icons');
if (!skipWeb) {
  run('node scripts/generate-app-icons.mjs');
}
run('node scripts/sync-android-icons.mjs');

console.log('\nStep 2/4: Web build + Capacitor sync');
if (!skipWeb) {
  run('npm run build');
}
run('npx cap sync android');

if (release) patchReleaseSigning();

const task = release && existsSync(keystoreProps) ? 'assembleRelease' : 'assembleDebug';
if (release && !existsSync(keystoreProps)) {
  console.log('\nNo keystore.properties — building debug APK (fine for testing).');
  console.log('For Play Store / production, add android/keystore.properties and re-run with --release\n');
}

console.log(`\nStep 3/4: Gradle ${task}`);
try {
  run(process.platform === 'win32' ? 'gradlew.bat --stop' : './gradlew --stop', androidDir);
} catch { /* no daemon yet */ }
run(process.platform === 'win32' ? `gradlew.bat ${task}` : `./gradlew ${task}`, androidDir);

const apkName = task === 'assembleRelease' ? 'app-release.apk' : 'app-debug.apk';
const apkSrc = join(androidDir, 'app', 'build', 'outputs', 'apk', task === 'assembleRelease' ? 'release' : 'debug', apkName);

if (!existsSync(apkSrc)) {
  console.error(`\nAPK not found at ${apkSrc}`);
  process.exit(1);
}

mkdirSync(downloadsDir, { recursive: true });
const apkDest = join(downloadsDir, 'scorr.apk');
copyFileSync(apkSrc, apkDest);

console.log(`\nStep 4/4: Copied to public/downloads/scorr.apk`);
console.log(`
Done! Users can download from your website:
  https://scorr.walfia.ai/#download-app

Deploy the site (npm run build && vercel --prod) to publish the APK.
APK size: ${(readFileSync(apkDest).length / 1024 / 1024).toFixed(1)} MB
`);

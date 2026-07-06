#!/usr/bin/env node
/**
 * Build Scorr for web + Android APK + iOS (Capacitor sync).
 * Same React app — departments, shifts, attendance on all platforms.
 *
 * Usage:
 *   node scripts/build-all-platforms.mjs           # build only
 *   node scripts/build-all-platforms.mjs --migrate # DB migrations first
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const migrate = process.argv.includes('--migrate');

function run(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

console.log('═══════════════════════════════════════');
console.log('  Scorr — build web + Android + iOS');
console.log('═══════════════════════════════════════\n');

if (migrate) {
  console.log('Step 1: Database migrations');
  run('node scripts/apply-all-migrations.mjs');
} else {
  console.log('Step 1: Skipping migrations (use --migrate to apply)\n');
}

console.log('\nStep 2: Web build + Capacitor sync (android + ios)');
run('npm run build');
run('node scripts/sync-ios-icons.mjs');
run('node scripts/sync-android-icons.mjs');
run('npx cap sync');

const hasAndroid = existsSync(join(root, 'android'));
const hasIos = existsSync(join(root, 'ios'));

if (hasAndroid) {
  console.log('\nStep 3: Android APK');
  try {
    run('node scripts/build-android-apk.mjs --skip-web');
  } catch (e) {
    console.warn('⚠️  Android APK build failed — web + sync still updated.');
    console.warn('   Fix Android SDK/JDK and run: node scripts/build-android-apk.mjs');
  }
} else {
  console.log('\nStep 3: Android skipped (no android/ folder). Run: node scripts/setup-mobile.mjs');
}

if (hasIos) {
  console.log('\nStep 4: iOS project synced');
  if (process.platform === 'darwin') {
    console.log('   Mac detected — optional: node scripts/build-ios-ipa.mjs --archive');
    console.log('   Or: npm run cap:ios → Run on device / TestFlight');
  } else {
    console.log('   iPhone install (no Mac): Safari → Add to Home Screen at your site URL');
    console.log('   Native IPA: run on Mac or GitHub Actions → Build iOS');
  }
}

console.log(`
═══════════════════════════════════════
Done! All platforms use the same features:

  • Department weightages (Admin/Manager → Departments)
  • Shift management + GPS attendance
  • KPI assign with auto weights

Deploy web:
  npx vercel --prod

Android APK:
  public/downloads/scorr.apk → commit & push for website download

iOS:
  Safari → Add to Home Screen, or TestFlight after Mac build
═══════════════════════════════════════
`);

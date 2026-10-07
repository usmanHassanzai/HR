#!/usr/bin/env node
/**
 * Create the permanent Android release keystore outside the repo.
 * Path: ~/.scorr/scorr-release.keystore + ~/.scorr/keystore.env
 * A backup copy is also written to ~/Scorr-keystore-backup/ (user-facing).
 *
 * Never commit keystores or passwords.
 */
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const scorrDir = join(homedir(), '.scorr');
const backupDir = join(homedir(), 'Scorr-keystore-backup');
const keystorePath = join(scorrDir, 'scorr-release.keystore');
const envPath = join(scorrDir, 'keystore.env');
const alias = process.env.SCORR_ANDROID_KEY_ALIAS || 'scorr';

function genPassword() {
  return randomBytes(24).toString('base64url');
}

mkdirSync(scorrDir, { recursive: true, mode: 0o700 });
mkdirSync(backupDir, { recursive: true, mode: 0o700 });

if (existsSync(keystorePath) && existsSync(envPath)) {
  console.log(`Keystore already present: ${keystorePath}`);
  console.log(`Env file: ${envPath}`);
  console.log(`Backup folder: ${backupDir}`);
  process.exit(0);
}

const storePassword = process.env.SCORR_ANDROID_STORE_PASSWORD || genPassword();
const keyPassword = process.env.SCORR_ANDROID_KEY_PASSWORD || storePassword;

if (!existsSync(keystorePath)) {
  console.log('Generating permanent release keystore…');
  execFileSync(
    'keytool',
    [
      '-genkeypair',
      '-v',
      '-keystore',
      keystorePath,
      '-alias',
      alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-storepass',
      storePassword,
      '-keypass',
      keyPassword,
      '-dname',
      'CN=Scorr, OU=Walfia, O=Walfia, L=Remote, ST=NA, C=US',
    ],
    { stdio: 'inherit' },
  );
  chmodSync(keystorePath, 0o600);
}

const envBody = [
  `# Permanent Scorr Android signing — DO NOT COMMIT`,
  `SCORR_ANDROID_KEYSTORE=${keystorePath}`,
  `SCORR_ANDROID_STORE_PASSWORD=${storePassword}`,
  `SCORR_ANDROID_KEY_ALIAS=${alias}`,
  `SCORR_ANDROID_KEY_PASSWORD=${keyPassword}`,
  '',
].join('\n');

writeFileSync(envPath, envBody, { mode: 0o600 });
copyFileSync(keystorePath, join(backupDir, 'scorr-release.keystore'));
writeFileSync(join(backupDir, 'keystore.env'), envBody, { mode: 0o600 });
writeFileSync(
  join(backupDir, 'README.txt'),
  [
    'Scorr Android release keystore backup',
    '====================================',
    '',
    'Keep this folder offline / encrypted. Losing it means you cannot update',
    'existing installs without forcing users to uninstall once.',
    '',
    `keystore: ${join(backupDir, 'scorr-release.keystore')}`,
    `env:      ${join(backupDir, 'keystore.env')}`,
    `alias:    ${alias}`,
    '',
    'Load into a build shell:',
    '  set -a && source ~/.scorr/keystore.env && set +a',
    '',
  ].join('\n'),
  { mode: 0o600 },
);

try {
  execSync(`chmod 700 "${scorrDir}" "${backupDir}"`);
} catch {
  /* ignore */
}

console.log(`✅ Keystore: ${keystorePath}`);
console.log(`✅ Env:      ${envPath}`);
console.log(`✅ Backup:   ${backupDir}`);
console.log('Users who still have a DEBUG-signed APK must uninstall once, then install this release APK.');

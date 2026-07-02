#!/usr/bin/env node
/**
 * Download portable Eclipse Temurin JDK 21 into .tools/jdk-21 (no sudo required).
 * Capacitor 8 / Gradle 8.14 requires Java 21.
 * Usage: node scripts/install-portable-jdk.mjs
 */
import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const root = new URL('..', import.meta.url).pathname;
const toolsDir = join(root, '.tools');
const jdkDir = join(toolsDir, 'jdk-21');
const jdkMarker = join(jdkDir, '.ready');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function main() {
  if (existsSync(jdkMarker)) {
    console.log('Portable JDK 21 already installed at .tools/jdk-21');
    return;
  }

  // Remove old JDK 17 if present
  for (const name of ['jdk-17', 'jdk17.tar.gz']) {
    const p = join(toolsDir, name);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  mkdirSync(toolsDir, { recursive: true });
  const api = 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk';
  const tarPath = join(toolsDir, 'jdk21.tar.gz');
  console.log('Downloading Temurin JDK 21 (~190 MB)…');
  await download(api, tarPath);

  console.log('Extracting…');
  execSync(`tar -xzf "${tarPath}" -C "${toolsDir}"`, { stdio: 'inherit' });

  const extracted = readdirSync(toolsDir).find((n) => n.startsWith('jdk-21') && n !== 'jdk-21');
  if (!extracted) throw new Error('JDK extract folder not found');
  renameSync(join(toolsDir, extracted), jdkDir);
  writeFileSync(jdkMarker, 'ok');
  if (existsSync(tarPath)) rmSync(tarPath, { force: true });
  console.log('JDK ready: .tools/jdk-21');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

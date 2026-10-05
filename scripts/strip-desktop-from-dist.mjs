#!/usr/bin/env node
/**
 * Remove Electron desktop packages from dist/downloads before Vercel upload.
 * They exceed Vercel's 100 MB file limit — host via GitHub Release instead.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'dist', 'downloads');
const names = [
  'Scorr-Windows.zip',
  'Scorr-Setup.exe',
  'Scorr.AppImage',
  'Scorr.deb',
];

let removed = 0;
for (const name of names) {
  const p = join(dir, name);
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`Removed dist/downloads/${name} (too large for Vercel)`);
    removed += 1;
  }
}
if (removed === 0) {
  console.log('No oversized desktop packages in dist/downloads.');
}

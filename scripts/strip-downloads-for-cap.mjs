#!/usr/bin/env node
/**
 * Remove large downloadables from dist before Capacitor sync so the native
 * WebView bundle does not embed the APK/PDF (~5.7MB+). Website keep serving
 * them from public/ → Vercel separately.
 */
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const downloads = join(root, 'dist', 'downloads');
if (existsSync(downloads)) {
  rmSync(downloads, { recursive: true, force: true });
  console.log('Removed dist/downloads before Capacitor sync (APK/PDF stay on website only).');
} else {
  console.log('No dist/downloads to strip.');
}

#!/usr/bin/env node
/**
 * Fail the desktop build if main.cjs or preload.cjs require a local file
 * that electron-builder left out of app.asar. Test files must not be packed.
 *
 * Usage: node scripts/verify-desktop-asar.mjs dist-desktop/win-unpacked/resources/app.asar
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(root, 'desktop');
const asarPath = resolve(process.argv[2] || join(root, 'dist-desktop', 'win-unpacked', 'resources', 'app.asar'));

if (!existsSync(asarPath)) {
  console.error(`app.asar not found: ${asarPath}`);
  process.exit(1);
}

function localRequires(source) {
  const found = [];
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(source))) found.push(match[1]);
  return found;
}

function resolveLocal(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.json`];
  return candidates.find((p) => existsSync(p)) || null;
}

function collectRequired(entry, seen, needed) {
  const abs = resolve(entry);
  if (seen.has(abs)) return;
  seen.add(abs);
  const text = readFileSync(abs, 'utf8');
  for (const spec of localRequires(text)) {
    const target = resolveLocal(abs, spec);
    if (!target) {
      throw new Error(`${relative(desktopDir, abs)} requires ${spec}, which is not on disk`);
    }
    const rel = relative(desktopDir, target).replace(/\\/g, '/');
    if (rel.endsWith('.test.cjs')) {
      throw new Error(`${relative(desktopDir, abs)} requires test file ${rel}`);
    }
    needed.add(rel);
    if (target.endsWith('.cjs') || target.endsWith('.js')) collectRequired(target, seen, needed);
  }
}

const needed = new Set(['main.cjs', 'preload.cjs']);
for (const entry of ['main.cjs', 'preload.cjs']) {
  collectRequired(join(desktopDir, entry), new Set(), needed);
}

const listed = spawnSync('npx', ['asar', 'list', asarPath], {
  cwd: root,
  encoding: 'utf8',
});
if (listed.status !== 0) {
  console.error(listed.stderr || listed.stdout || 'asar list failed');
  process.exit(listed.status || 1);
}

const packed = new Set(
  listed.stdout
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/').replace(/^\//, ''))
    .filter(Boolean),
);

const missing = [...needed].filter((rel) => !packed.has(rel));
const packedTests = [...packed].filter((rel) => rel.endsWith('.test.cjs'));

if (missing.length || packedTests.length) {
  if (missing.length) console.error(`Missing from app.asar:\n${missing.map((f) => `  ${f}`).join('\n')}`);
  if (packedTests.length) console.error(`Test files packed in app.asar:\n${packedTests.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}

console.log(`app.asar includes ${needed.size} required local file(s):`);
for (const rel of [...needed].sort()) console.log(`  ${rel}`);
console.log('No *.test.cjs files packed.');

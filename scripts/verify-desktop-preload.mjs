#!/usr/bin/env node
/**
 * Load the desktop preload with the same sandbox the app window uses.
 * The required method list is the desktop-v1.3.45 bridge. getAppVersion is
 * not part of that bridge and must stay absent.
 *
 * Also asserts preload.cjs is byte-identical to tag desktop-v1.3.45.
 *
 * Usage:
 *   node scripts/verify-desktop-preload.mjs
 *   node scripts/verify-desktop-preload.mjs dist-desktop/win-unpacked/resources/app.asar
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

const REQUIRED_FUNCTIONS = [
  'expandWorkspace',
  'shrinkToLogin',
  'saveAttendanceToken',
  'clearAttendanceToken',
  'hasAttendanceToken',
  'saveLoginCredentials',
  'loadLoginCredentials',
  'clearLoginCredentials',
  'saveTrustedDeviceToken',
  'loadTrustedDeviceToken',
  'clearTrustedDeviceToken',
  'setAutoLaunch',
  'getAutoLaunch',
  'checkForUpdates',
  'quitAndInstall',
  'probeWifi',
  'onUpdateReady',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function preloadText(target) {
  if (!target.endsWith('.asar')) return readFileSync(target, 'utf8');
  const asar = require('@electron/asar');
  return asar.extractFile(target, 'preload.cjs').toString('utf8');
}

function assertNoLocalRequire(source, label) {
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const local = requires.filter((spec) => spec !== 'electron');
  if (local.length) {
    fail(`${label} require()s local files, which the sandboxed preload cannot load:\n${local.map((s) => `  ${s}`).join('\n')}`);
  }
  if (!requires.includes('electron')) {
    fail(`${label} does not require electron`);
  }
}

const tag = spawnSync('git', ['show', 'desktop-v1.3.45:desktop/preload.cjs'], {
  cwd: root,
  encoding: 'utf8',
});
if (tag.status !== 0) fail(tag.stderr || 'could not read desktop-v1.3.45 preload');

const target = resolve(process.argv[2] || join(root, 'desktop', 'preload.cjs'));
const source = preloadText(target);
if (source !== tag.stdout) {
  fail(`${target} is not byte-identical to desktop-v1.3.45:desktop/preload.cjs`);
}
assertNoLocalRequire(source, target);

const dir = mkdtempSync(join(tmpdir(), 'scorr-preload-'));
const mainPath = join(dir, 'main.cjs');
const preloadPath = target.endsWith('.asar') ? join(target, 'preload.cjs') : target;
writeFileSync(mainPath, `
const { app, BrowserWindow } = require('electron');
const required = ${JSON.stringify(REQUIRED_FUNCTIONS)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: ${JSON.stringify(preloadPath)},
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await win.loadURL('data:text/html,<!doctype html><title>preload</title>');
    const result = await win.webContents.executeJavaScript(
      '(() => { const api = window.scorrDesktop; const required = ' + JSON.stringify(required) +
      '; if (!api || api.isDesktop !== true) return { ok: false, reason: "scorrDesktop missing" };' +
      'const missing = required.filter((name) => typeof api[name] !== "function");' +
      'if (typeof api.platform !== "string") missing.push("platform");' +
      'if (typeof api.getAppVersion === "function") missing.push("unexpected getAppVersion");' +
      'return { ok: missing.length === 0, missing, platform: api.platform }; })()',
      true,
    );
    console.log(JSON.stringify(result));
    app.exit(result && result.ok ? 0 : 1);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
`);

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_DISABLE_SANDBOX;
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [mainPath], {
  encoding: 'utf8',
  env,
  timeout: 20000,
});
rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${run.stdout || ''}\n${run.stderr || ''}`);
if (run.status !== 0) {
  fail(`Sandboxed preload check failed (exit ${run.status ?? 'null'})`);
}
console.log(`preload.cjs matches desktop-v1.3.45 and exposes ${REQUIRED_FUNCTIONS.length} bridge methods.`);

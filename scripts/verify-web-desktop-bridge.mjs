#!/usr/bin/env node
/**
 * Load the real desktop-v1.3.45 preload (packaged 1.3.48 asar, byte-checked)
 * and render Automatic check-in. Missing getAppVersion must not show
 * "This Scorr Desktop is unknown". No attendance request is sent.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const asarPath = process.argv[2]
  || '/home/usman/walfia.ai/.worktrees/win11min/dist-desktop/win-unpacked/resources/app.asar';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const tag = spawnSync('git', ['show', 'desktop-v1.3.45:desktop/preload.cjs'], {
  cwd: root,
  encoding: 'utf8',
});
if (tag.status !== 0) fail(tag.stderr || 'could not read desktop-v1.3.45 preload');

const releaseSrc = readFileSync(join(root, 'scripts/write-version-json.mjs'), 'utf8');
const releaseMatch = releaseSrc.match(/const WINDOWS_RELEASE = '(\d+(?:\.\d+){1,2})'/);
if (!releaseMatch) fail('WINDOWS_RELEASE missing from scripts/write-version-json.mjs');
const windowsRelease = releaseMatch[1];

const asar = require('@electron/asar');
const packed = asar.extractFile(asarPath, 'preload.cjs').toString('utf8');
if (packed !== tag.stdout) fail('packaged preload is not byte-identical to desktop-v1.3.45');

const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'scorr-web-bridge-'));
const entry = join(dir, 'screen.tsx');
const bundle = join(dir, 'screen.js');
const htmlPath = join(dir, 'screen.html');
const mainPath = join(dir, 'main.cjs');
const preloadPath = join(dir, 'preload.cjs');
writeFileSync(preloadPath, packed);

writeFileSync(entry, `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import AutoAttendanceSavePanel from ${JSON.stringify(join(root, 'src/components/AutoAttendanceSavePanel.tsx'))};
import AppUpdateBanner from ${JSON.stringify(join(root, 'src/components/AppUpdateBanner.tsx'))};
import { evaluateUpdate } from ${JSON.stringify(join(root, 'src/utils/appUpdate.ts'))};
import { getAutoAttendanceSaveStatus, saveAccountForAutoAttendance } from ${JSON.stringify(join(root, 'src/utils/autoAttendanceEnroll.ts'))};

const geo = {
  getCurrentPosition(_ok, err) { err?.(new Error('blocked')); },
};
try { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geo }); } catch { /* ignore */ }

const rootEl = document.getElementById('root');
createRoot(rootEl).render(createElement('div', null, createElement(AutoAttendanceSavePanel), createElement(AppUpdateBanner)));

window.__scorrBridgeResult = async () => {
  const status = await getAutoAttendanceSaveStatus();
  const save = await saveAccountForAutoAttendance();
  const update = await evaluateUpdate({
    webBuildId: '',
    windows: { version: ${JSON.stringify(windowsRelease)}, setupUrl: 'https://github.com/usmanHassanzai/HR/releases/download/desktop-v' + ${JSON.stringify(windowsRelease)} + '/Scorr-Setup.exe' },
    linux: { version: '1.3.45' },
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  return {
    kind: status.kind,
    platformLabel: status.platformLabel,
    text: document.body.innerText,
    saveOk: save.ok,
    saveError: save.error || '',
    hasGetAppVersion: typeof window.scorrDesktop?.getAppVersion === 'function',
    bridge: window.scorrDesktop ? Object.keys(window.scorrDesktop) : [],
    updateKind: update.kind,
    updateMessage: update.kind === 'native' ? update.message : '',
  };
};
`);

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [entry],
  nodePaths: [join(root, 'node_modules')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: bundle,
  jsx: 'automatic',
  define: {
    __SCORR_WINDOWS_DESKTOP_RELEASE__: JSON.stringify(windowsRelease),
    'import.meta.env': JSON.stringify({
      DEV: false,
      PROD: true,
      MODE: 'production',
      SSR: false,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    }),
  },
  logLevel: 'warning',
});

writeFileSync(htmlPath, `<!doctype html><html><body><div id="root"></div><script src="./screen.js"></script></body></html>`);

writeFileSync(mainPath, `
const { app, BrowserWindow, ipcMain, session } = require('electron');
const updaterCalls = { checkForUpdates: 0, quitAndInstall: 0 };
ipcMain.handle('scorr:checkForUpdates', () => {
  updaterCalls.checkForUpdates += 1;
  return { ok: true, updateAvailable: true, autoInstall: true };
});
ipcMain.handle('scorr:quitAndInstall', () => {
  updaterCalls.quitAndInstall += 1;
  return { ok: true };
});
for (const channel of [
  'scorr:saveAttendanceToken','scorr:clearAttendanceToken','scorr:hasAttendanceToken',
  'scorr:saveLoginCredentials','scorr:loadLoginCredentials','scorr:clearLoginCredentials',
  'scorr:saveTrustedDeviceToken','scorr:loadTrustedDeviceToken','scorr:clearTrustedDeviceToken',
  'scorr:setAutoLaunch','scorr:getAutoLaunch','scorr:probeWifi',
]) {
  ipcMain.handle(channel, () => (channel === 'scorr:hasAttendanceToken' ? false : { ok: true, enabled: true }));
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('file:')) { callback({}); return; }
    callback({ cancel: true });
  });
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
    await win.loadFile(${JSON.stringify(htmlPath)});
    const started = Date.now();
    let result = null;
    while (Date.now() - started < 20000) {
      result = await win.webContents.executeJavaScript(
        'window.__scorrBridgeResult ? window.__scorrBridgeResult() : null',
        true,
      );
      if (result && result.text && result.text.includes('Automatic check-in')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    result.updaterCalls = updaterCalls;
    console.log(JSON.stringify(result));
    const text = String(result && result.text || '');
    const err = String(result && result.saveError || '');
    const bad = /This Scorr Desktop is/.test(text) || /This Scorr Desktop is/.test(err);
    const supported = result && result.kind === 'desktop' && /desktop/i.test(result.platformLabel || '') && !bad && result.hasGetAppVersion === false;
    const noRestart = result.updateKind === 'none' && updaterCalls.checkForUpdates === 0 && updaterCalls.quitAndInstall === 0;
    app.exit(supported && noRestart ? 0 : 1);
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
const run = spawnSync(electron, [mainPath], { encoding: 'utf8', env, timeout: 30000 });
process.stdout.write(`${run.stdout || ''}\n${run.stderr || ''}`);
rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) fail(`Automatic check-in screen check failed (exit ${run.status ?? 'null'})`);

const assets = join(root, 'dist', 'assets');
let built = '';
try {
  for (const name of readdirSync(assets)) {
    if (!name.endsWith('.js')) continue;
    const text = readFileSync(join(assets, name), 'utf8');
    if (text.includes('This Scorr Desktop is')) built += text;
  }
} catch (error) {
  fail(`web build assets missing: ${error.message}`);
}
if (!built) fail('built web bundle does not contain the Automatic check-in desktop message');
if (!built.includes('if(!e)return!1') && !built.includes('if(!t)return!1') && !built.includes('if(!n)return!1')) {
  fail('built bundle still treats a missing desktop version as too old');
}
console.log('Automatic check-in shows the desktop as supported. Built bundle does not treat a missing version as too old.');

/**
 * Preload bridge for the remote web UI (https://scorr.walfia.ai).
 * Must expose window.scorrDesktop on every boot — auto check-in depends on it.
 *
 * With contextIsolation:false (main window), assigning window.scorrDesktop reaches the page.
 * contextBridge is kept as a fallback when isolation is enabled.
 */
const { ipcRenderer, contextBridge } = require('electron');
const { isWindows11Build, readWindowsBuildNumber } = require('./windowsVariant.cjs');

const windowsBuild = readWindowsBuildNumber();
const platformVariant = isWindows11Build(windowsBuild) ? 'windows11' : undefined;

const api = {
  isDesktop: true,
  platform: process.platform,
  platformVariant,
  windowsBuild,
  /** Electron binary version (not the web bundle). */
  getAppVersion: () => ipcRenderer.invoke('scorr:getAppVersion'),
  expandWorkspace: () => ipcRenderer.send('scorr:workspace'),
  shrinkToLogin: () => ipcRenderer.send('scorr:login'),
  saveAttendanceToken: (token) => ipcRenderer.invoke('scorr:saveAttendanceToken', token),
  clearAttendanceToken: () => ipcRenderer.invoke('scorr:clearAttendanceToken'),
  hasAttendanceToken: () => ipcRenderer.invoke('scorr:hasAttendanceToken'),
  saveLoginCredentials: (email, password) => ipcRenderer.invoke('scorr:saveLoginCredentials', email, password),
  loadLoginCredentials: () => ipcRenderer.invoke('scorr:loadLoginCredentials'),
  clearLoginCredentials: () => ipcRenderer.invoke('scorr:clearLoginCredentials'),
  saveTrustedDeviceToken: (token) => ipcRenderer.invoke('scorr:saveTrustedDeviceToken', token),
  loadTrustedDeviceToken: () => ipcRenderer.invoke('scorr:loadTrustedDeviceToken'),
  clearTrustedDeviceToken: () => ipcRenderer.invoke('scorr:clearTrustedDeviceToken'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('scorr:setAutoLaunch', Boolean(enabled)),
  getAutoLaunch: () => ipcRenderer.invoke('scorr:getAutoLaunch'),
  checkForUpdates: () => ipcRenderer.invoke('scorr:checkForUpdates'),
  quitAndInstall: () => ipcRenderer.invoke('scorr:quitAndInstall'),
  probeWifi: () => ipcRenderer.invoke('scorr:probeWifi'),
  wifiDiagnostics: () => ipcRenderer.invoke('scorr:wifiDiagnostics'),
  openLocationSettings: () => ipcRenderer.invoke('scorr:openLocationSettings'),
  prepareAutoAttendance: () => ipcRenderer.invoke('scorr:prepareAutoAttendance'),
  notifyManualCheckout: () => ipcRenderer.invoke('scorr:manualCheckout'),
  onUpdateReady: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scorr:update-ready', handler);
    return () => ipcRenderer.removeListener('scorr:update-ready', handler);
  },
  /** Phases: checking | available | downloading | installing | restarting | none | error | manual | pending-quit */
  onUpdateStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scorr:update-status', handler);
    return () => ipcRenderer.removeListener('scorr:update-status', handler);
  },
};

let exposed = false;
// Prefer direct window assign FIRST. On Windows, contextBridge-before-assign with
// contextIsolation:false can leave a broken / non-invokable scorrDesktop (Enable fails
// even though isDesktop looks true). Linux already relies on this assign path.
try {
  // contextIsolation:false → this IS the page window.
  window.scorrDesktop = api;
  exposed = true;
} catch (e) {
  console.warn('[scorr-preload] window.scorrDesktop assign failed', e);
}

try {
  // Fallback when contextIsolation:true (isolated world cannot assign to the page).
  contextBridge.exposeInMainWorld('scorrDesktop', api);
  exposed = true;
} catch (e) {
  // Expected when contextIsolation:false — window assign above is enough.
  if (!exposed) console.warn('[scorr-preload] contextBridge.exposeInMainWorld failed', e);
}

if (!exposed) {
  console.error('[scorr-preload] FAILED to expose scorrDesktop — auto check-in will not arm');
}

/** In-window Windows status. No system toast. Hidden when the web screen is present. */
function installWindowsWifiPanel() {
  if (platformVariant !== 'windows11') return;
  const draw = async () => {
    if (document.querySelector('[data-scorr-wifi-diagnostics]')) {
      const old = document.getElementById('scorr-wifi-panel');
      if (old) old.remove();
      return;
    }
    let snap = null;
    try {
      snap = await api.wifiDiagnostics();
    } catch {
      return;
    }
    if (!snap) return;
    let root = document.getElementById('scorr-wifi-panel');
    if (!root) {
      root = document.createElement('section');
      root.id = 'scorr-wifi-panel';
      root.setAttribute('data-scorr-injected-wifi', '1');
      root.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000;max-width:360px;background:#fff;color:#0f172a;border:1px solid #cbd5e1;border-radius:12px;padding:12px 14px;font:13px/1.4 Segoe UI,sans-serif;box-shadow:0 8px 24px rgba(15,23,42,.12)';
      document.body.appendChild(root);
    }
    const line = (label, value) => {
      const p = document.createElement('p');
      p.style.margin = '4px 0 0';
      p.textContent = `${label}: ${value || '—'}`;
      return p;
    };
    root.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'Wi-Fi diagnostics';
    const status = document.createElement('p');
    status.style.margin = '6px 0 0';
    status.textContent = snap.statusLine || '';
    root.append(
      title,
      status,
      line('Windows', snap.windowsVersion || 'unknown'),
      line('Location', snap.locationAllowed === true ? 'allowed' : snap.locationAllowed === false ? 'off' : 'unknown'),
      line('SSID', snap.ssid),
      line('BSSID', snap.bssid),
      line('Public IP', snap.publicIp),
      line('Saved network', snap.matchesSaved ? 'yes' : 'no'),
      line('Last result', (snap.lastResult && (snap.lastResult.reason || snap.lastResult.action)) || ''),
      line('Start at login', snap.autoLaunch ? 'on' : 'off'),
      line('Tray process', snap.trayRunning ? 'running' : 'not running'),
    );
    if (snap.locationMessage) {
      const msg = document.createElement('p');
      msg.style.margin = '8px 0 0';
      msg.textContent = snap.locationMessage;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.marginTop = '8px';
      btn.textContent = 'Open Location settings';
      btn.onclick = () => { void api.openLocationSettings(); };
      root.append(msg, btn);
    }
  };
  const boot = () => {
    void draw();
    setInterval(() => { void draw(); }, 15000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

try {
  installWindowsWifiPanel();
} catch (e) {
  console.warn('[scorr-preload] wifi panel skipped', e);
}

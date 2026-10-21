const { contextBridge, ipcRenderer } = require('electron');

const platformVariant = ipcRenderer.sendSync('scorr:platformVariantSync');
const windowsBuild = ipcRenderer.sendSync('scorr:windowsBuildSync');

contextBridge.exposeInMainWorld('scorrDesktop', {
  isDesktop: true,
  platform: process.platform,
  platformVariant,
  windowsBuild,
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
  onUpdateReady: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scorr:update-ready', handler);
    return () => ipcRenderer.removeListener('scorr:update-ready', handler);
  },
});

if (platformVariant === 'windows11') {
  const install = () => {
    if (document.getElementById('scorr-win11-wifi')) return;
    const box = document.createElement('details');
    box.id = 'scorr-win11-wifi';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;max-width:320px;background:#0f172a;color:#e2e8f0;font:12px/1.4 sans-serif;padding:8px 10px;border-radius:8px;';
    const summary = document.createElement('summary');
    summary.textContent = 'Wi-Fi diagnostics';
    box.appendChild(summary);
    const body = document.createElement('div');
    box.appendChild(body);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Open Location settings';
    button.style.cssText = 'margin-top:8px;display:none;';
    button.addEventListener('click', () => {
      void ipcRenderer.invoke('scorr:openLocationSettings');
    });
    box.appendChild(button);
    const refresh = async () => {
      const snap = await ipcRenderer.invoke('scorr:wifiDiagnostics');
      const lines = [
        snap?.notRunningNote,
        `Windows: ${snap?.windowsVersion || ''}`,
        `Location: ${snap?.locationAllowed == null ? 'unknown' : snap.locationAllowed ? 'allowed' : 'off'}`,
        `SSID: ${snap?.ssid || '(blank)'}`,
        `BSSID: ${snap?.bssid || '(blank)'}`,
        `Public IP: ${snap?.publicIp || '(blank)'}`,
        `Matches saved network: ${snap?.matchesSaved ? 'yes' : 'no'}`,
        `Last result: ${snap?.lastResult?.action || snap?.lastResult?.reason || 'none'}`,
        `Start at login: ${snap?.autoLaunch ? 'yes' : 'no'}`,
        `Tray running: ${snap?.trayRunning ? 'yes' : 'no'}`,
        `Log: ${snap?.logPath || ''}`,
      ].filter(Boolean);
      body.textContent = lines.join('\n');
      button.style.display = snap?.locationMessage ? 'inline-block' : 'none';
      if (snap?.locationMessage) button.title = snap.locationMessage;
    };
    box.addEventListener('toggle', () => {
      if (box.open) void refresh();
    });
    document.body.appendChild(box);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
}

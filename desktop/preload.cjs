const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scorrDesktop', {
  isDesktop: true,
  platform: process.platform,
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
  onUpdateReady: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scorr:update-ready', handler);
    return () => ipcRenderer.removeListener('scorr:update-ready', handler);
  },
});

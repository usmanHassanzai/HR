const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scorrDesktop', {
  isDesktop: true,
  platform: process.platform,
  expandWorkspace: () => ipcRenderer.send('scorr:workspace'),
  shrinkToLogin: () => ipcRenderer.send('scorr:login'),
});

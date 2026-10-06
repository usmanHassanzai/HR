const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scorrDesktop', {
  isDesktop: true,
  platform: process.platform,
  expandWorkspace: () => ipcRenderer.send('scorr:workspace'),
  shrinkToLogin: () => ipcRenderer.send('scorr:login'),
  saveAttendanceToken: (token) => ipcRenderer.invoke('scorr:saveAttendanceToken', token),
  clearAttendanceToken: () => ipcRenderer.invoke('scorr:clearAttendanceToken'),
  hasAttendanceToken: () => ipcRenderer.invoke('scorr:hasAttendanceToken'),
});

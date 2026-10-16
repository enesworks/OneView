const { contextBridge, ipcRenderer } = require('electron');

const api = {
  streamAcquire: (camera) => ipcRenderer.invoke('stream:acquire', camera),
  streamRelease: (sessionId) => ipcRenderer.send('stream:release', sessionId),
  streamProbe: (url) => ipcRenderer.invoke('stream:probe', url),
  streamTouch: (sessionId) => ipcRenderer.send('stream:touch', sessionId),
  registryList: () => ipcRenderer.invoke('registry:list'),
  registryStats: () => ipcRenderer.invoke('registry:stats'),
  storeScan: () => ipcRenderer.invoke('store:scan'),
  livenessCheck: () => ipcRenderer.invoke('liveness:check'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  quitApp: () => ipcRenderer.send('app:quit'),
};

contextBridge.exposeInMainWorld('onView', api);

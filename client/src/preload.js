'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loveRoom', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  setPartner: (code) => ipcRenderer.invoke('partner:set', code),
  clearPartner: () => ipcRenderer.invoke('partner:clear'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  sendUrl: (url) => ipcRenderer.invoke('gif:send-url', url),
  sendFile: (file) => ipcRenderer.invoke('gif:send-file', file),
  testOverlay: () => ipcRenderer.invoke('overlay:test'),
  onOverlayShow: (cb) => ipcRenderer.on('overlay:show', (_e, p) => cb(p)),
  onOverlayHide: (cb) => ipcRenderer.on('overlay:hide', () => cb()),
});

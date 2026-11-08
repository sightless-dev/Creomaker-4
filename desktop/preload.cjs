'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('creoDesktop', {
  isDesktop: true,
  selectDirectory: defaultPath => ipcRenderer.invoke('dialog:select-directory', defaultPath),
  openPath: targetPath => ipcRenderer.invoke('shell:open-path', targetPath)
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('creoDesktop', {
  isDesktop: true,
  platform: process.platform,
  selectDirectory: defaultPath => ipcRenderer.invoke('dialog:select-directory', defaultPath),
  openPath: targetPath => ipcRenderer.invoke('shell:open-path', targetPath),
  setTheme: theme => ipcRenderer.invoke('window:set-theme', theme),
  showMenu: pos => ipcRenderer.invoke('window:show-menu', pos),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize')
});

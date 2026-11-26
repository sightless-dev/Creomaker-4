'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('creoDesktop', {
  isDesktop: true,
  platform: process.platform,
  // Real path of a dropped or picked file, so the app reads it in place instead of copying it.
  getPathForFile: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  selectDirectory: defaultPath => ipcRenderer.invoke('dialog:select-directory', defaultPath),
  openPath: targetPath => ipcRenderer.invoke('shell:open-path', targetPath),
  setTheme: theme => ipcRenderer.invoke('window:set-theme', theme),
  showMenu: pos => ipcRenderer.invoke('window:show-menu', pos),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize')
});

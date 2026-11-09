/* Independent browser state and shell for the local CreoMaker application. */
(() => {
  'use strict';
  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('creomaker-local-workspace', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  window.CreoWorkspaceStore = {
    async getSetting(key) {
      const db = await database;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readonly');
        const request = tx.objectStore('settings').get(key);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error || Error('Не удалось прочитать настройки.'));
      });
    },
    async setting(key, value) {
      const db = await database;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || Error('Не удалось сохранить настройки.'));
      });
    }
  };
  document.addEventListener('DOMContentLoaded', async () => {
    const isMac = /macintosh|mac os x/i.test(navigator.userAgent) || Boolean(navigator.platform?.includes('Mac'));
    if (isMac) document.documentElement.classList.add('is-mac');
    for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = UIIcons.icon(element.dataset.icon);
    const theme = document.getElementById('theme-toggle');
    const savedTheme = await CreoWorkspaceStore.getSetting('theme').catch(() => null);
    document.documentElement.dataset.theme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    theme.addEventListener('click', async () => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      await CreoWorkspaceStore.setting('theme', document.documentElement.dataset.theme);
    });
    const refresh = () => CreoMaker.refreshLibrary().catch(() => {});
    window.addEventListener('focus', refresh);
    try { await CreoMaker.open(); }
    catch (error) { document.getElementById('cm-status').textContent = error.message; }
  });
})();

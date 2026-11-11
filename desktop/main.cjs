'use strict';
/*
 * CreoMaker desktop shell (Electron).
 *
 * The desktop build runs the very same code as the browser build:
 *   - the bundled app code (public/, src/, server.cjs …) is copied once into a writable
 *     folder inside the user profile, so the built-in GitHub updater («Проверить обновления»)
 *     can update it exactly like in the browser version;
 *   - the local server runs in an Electron utility process, FFmpeg/FFprobe and the tails/music
 *     library are shipped inside the app resources;
 *   - the window simply shows http://127.0.0.1:<port>, so UI and behaviour stay identical.
 */
const { app, BrowserWindow, Menu, shell, utilityProcess, dialog, nativeTheme, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const CODE_ENTRIES = ['public', 'src', 'tests', 'server.cjs', 'package.json', 'README.md', '.update-meta.json', '.desktop-bundle.json'];
const BASE_PORT = Number(process.env.CREOMAKER_DESKTOP_PORT || 4291);
const SELFTEST_DIR = process.env.CREOMAKER_SELFTEST || '';
const isMac = process.platform === 'darwin';

// Keep desktop data separate from the browser build (which uses "CreoMaker" on macOS).
app.setName('CreoMaker');
if (SELFTEST_DIR) {
  app.setPath('userData', path.join(require('node:os').tmpdir(), 'creomaker-selftest-' + process.pid));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'CreoMaker Desktop'));
}

let mainWindow = null;
let server = null;
let origin = '';
let quitting = false;
const logLines = [];

function log(...parts) {
  const line = new Date().toISOString() + ' ' + parts.join(' ');
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), line + '\n'); } catch {}
  if (!app.isPackaged || SELFTEST_DIR) console.log(line);
}

const resourcesRoot = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, 'bundle'));
const readJSON = async file => { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } };

/** Copies the bundled code into the profile on first launch or after installing a newer build. */
async function ensureCode() {
  const bundled = path.join(resourcesRoot(), 'app-code');
  const target = path.join(app.getPath('userData'), 'app');
  const bundleInfo = (await readJSON(path.join(bundled, '.desktop-bundle.json'))) || { buildId: 'dev' };
  const installedInfo = await readJSON(path.join(target, '.desktop-bundle.json'));
  const hasCode = fs.existsSync(path.join(target, 'server.cjs'));

  if (hasCode && installedInfo?.buildId === bundleInfo.buildId) return target;

  if (hasCode && installedInfo) {
    // The installed code may already be newer (updated from GitHub after this build was made).
    const meta = await readJSON(path.join(target, '.update-meta.json'));
    const updatedAt = Date.parse(meta?.updatedAt || '');
    const bundleTime = Date.parse(bundleInfo.commitTime || '');
    // updatedAt is when the in-app updater ran, not when that code was written, so a time comparison alone
    // could keep an older UI after installing a newer app version. A newer bundled version always wins.
    const installedVersion = (await readJSON(path.join(target, 'package.json')))?.version || '0';
    const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
    const bundleIsNewer = newer(bundleInfo.version || '0', installedVersion);
    if (!bundleIsNewer && (meta?.commitSha && meta.commitSha === bundleInfo.commitSha || (updatedAt && bundleTime && updatedAt > bundleTime))) {
      await fsp.writeFile(path.join(target, '.desktop-bundle.json'), JSON.stringify(bundleInfo, null, 2));
      log('Keeping installed code (same or newer than bundle).');
      return target;
    }
  }

  log('Installing bundled app code into', target);
  const staging = target + '.new';
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  for (const entry of CODE_ENTRIES) {
    const from = path.join(bundled, entry);
    if (fs.existsSync(from)) await fsp.cp(from, path.join(staging, entry), { recursive: true, force: true });
  }
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(staging, target);
  return target;
}

function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let port = BASE_PORT; port < BASE_PORT + 20; port++) if (await portFree(port)) return port;
  throw Error('Не найден свободный локальный порт (' + BASE_PORT + '–' + (BASE_PORT + 19) + ').');
}

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function toolPaths() {
  const bin = path.join(resourcesRoot(), 'bin');
  const exe = process.platform === 'win32' ? '.exe' : '';
  return { ffmpeg: path.join(bin, 'ffmpeg' + exe), ffprobe: path.join(bin, 'ffprobe' + exe) };
}

async function startServer(codeDir, port) {
  const tools = toolPaths();
  const bundledAssets = path.join(resourcesRoot(), 'assets');
  let hasBundledAssets = false;
  try {
    const list = fs.readdirSync(bundledAssets);
    hasBundledAssets = list.some(d => ['Tails', 'tails', 'music'].includes(d) && fs.readdirSync(path.join(bundledAssets, d)).length > 0);
  } catch {}
  const assetDir = hasBundledAssets ? bundledAssets : path.join(app.getPath('userData'), 'assets');
  try { fs.mkdirSync(assetDir, { recursive: true }); } catch {}

  const env = {
    ...process.env,
    CREOMAKER_PORT: String(port),
    CREOMAKER_DESKTOP: '1',
    CREO_DATA_DIR: path.join(app.getPath('userData'), 'data'),
    CREO_ASSET_DIR: assetDir
  };
  if (fs.existsSync(tools.ffmpeg)) env.CREO_FFMPEG_PATH = tools.ffmpeg;
  if (fs.existsSync(tools.ffprobe)) env.CREO_FFPROBE_PATH = tools.ffprobe;

  server = utilityProcess.fork(path.join(codeDir, 'server.cjs'), [], {
    cwd: codeDir, env, stdio: 'pipe', serviceName: 'CreoMaker Server'
  });
  server.stdout?.on('data', d => log('[server]', String(d).trim()));
  server.stderr?.on('data', d => log('[server:err]', String(d).trim()));
  server.on('exit', code => {
    log('Server exited with code', code);
    server = null;
    if (!quitting) {
      dialog.showErrorBox('CreoMaker', 'Локальный обработчик CreoMaker неожиданно завершился (код ' + code + ').\n\nЖурнал: ' + path.join(app.getPath('userData'), 'desktop.log'));
      app.quit();
    }
  });

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const h = await health(port);
    if (h?.service === 'CreoMaker') return h;
    if (!server) throw Error('Локальный обработчик не запустился.');
    await new Promise(r => setTimeout(r, 250));
  }
  throw Error('Локальный обработчик не ответил за 60 секунд.');
}

function buildMenu() {
  // userGesture=true: menu commands count as a user action, so e.g. the file picker is allowed to open.
  const page = js => () => mainWindow?.webContents.executeJavaScript(js, true).catch(() => {});
  // Windows: the page owns the shortcut and the menu only displays it (registerAccelerator:false).
  // macOS ignores registerAccelerator, so there the menu owns Cmd shortcuts and the page skips them
  // (see shell.js); plain-key hints like "P" are not shown on macOS so typing is never intercepted.
  const keys = (accelerator) => isMac
    ? (/CmdOrCtrl/.test(accelerator) ? { accelerator } : {})
    : { accelerator, registerAccelerator: false };
  const clickUpdate = () => mainWindow?.webContents.executeJavaScript("document.getElementById('cm-update-btn')?.click()").catch(() => {});
  const clickChangeDir = () => mainWindow?.webContents.executeJavaScript("window.changeOutputDir?.()").catch(() => {});
  const clickOpenDir = () => mainWindow?.webContents.executeJavaScript("window.openOutputDir?.()").catch(() => {});
  const template = [
    ...(isMac ? [{
      label: 'CreoMaker',
      submenu: [
        { role: 'about', label: 'О программе CreoMaker' },
        { type: 'separator' },
        { label: 'Проверить обновления…', click: clickUpdate },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть CreoMaker' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: 'Завершить CreoMaker' }
      ]
    }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Добавить файлы…', ...keys('CmdOrCtrl+O'), click: page('window.CreoShell?.addFiles()') },
        { label: 'Создать видео', ...keys('CmdOrCtrl+Enter'), click: page('window.CreoShell?.run()') },
        { label: 'Прослушать с музыкой', ...keys('P'), click: page('window.CreoShell?.playMix()') },
        { type: 'separator' },
        { label: 'Папка вывода креативов…', click: clickChangeDir },
        { label: 'Открыть папку вывода', click: clickOpenDir },
        ...(isMac ? [] : [
          { type: 'separator' },
          { label: 'Проверить обновления…', click: clickUpdate },
          { type: 'separator' },
          { role: 'quit', label: 'Выход' }
        ])
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать всё' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Монтаж', ...keys('CmdOrCtrl+1'), click: page("window.CreoShell?.showView('edit')") },
        { label: 'Медиатека', ...keys('CmdOrCtrl+2'), click: page("window.CreoShell?.showView('library')") },
        { label: 'Экспорт', ...keys('CmdOrCtrl+3'), click: page("window.CreoShell?.showView('results')") },
        { type: 'separator' },
        { label: 'Светлая / тёмная тема', click: page("document.getElementById('theme-toggle')?.click()") },
        { type: 'separator' },
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Масштабировать' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Все окна — на передний план' }] : [{ role: 'close', label: 'Закрыть' }])
      ]
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Инструкция для macOS', click: () => shell.openExternal(origin ? origin + '/macos-guide.html' : 'https://github.com/sightless-dev/Creomaker-4') },
        { type: 'separator' },
        { label: 'Папка данных CreoMaker', click: () => shell.openPath(app.getPath('userData')) },
        { label: 'Репозиторий на GitHub', click: () => shell.openExternal('https://github.com/sightless-dev/Creomaker-4') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


/* ---------- Native window chrome ---------- */
const CHROME = {
  dark: { bg: '#1c1c1e', overlay: '#1c1c1e', symbol: '#d4d4d8' },
  light: { bg: '#ececee', overlay: '#ececee', symbol: '#3f3f46' }
};
const TITLEBAR_H = 40;
let chromeTheme = 'dark';

function windowStateFile() { return path.join(app.getPath('userData'), 'window-state.json'); }
function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return Number.isFinite(s.x) && Number.isFinite(s.y) && s.x < a.x + a.width - 80 && s.x + s.width > a.x + 80 && s.y >= a.y - 10 && s.y < a.y + a.height - 80;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch { return null; }
}
function saveWindowState() {
  if (!mainWindow || SELFTEST_DIR) return;
  try {
    const maximized = mainWindow.isMaximized();
    const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...b, maximized }));
  } catch {}
}

function applyChromeTheme(theme) {
  chromeTheme = theme === 'light' ? 'light' : 'dark';
  const c = CHROME[chromeTheme];
  if (!mainWindow) return;
  try { mainWindow.setBackgroundColor(c.bg); } catch {}
  if (!isMac) {
    try { mainWindow.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbol, height: TITLEBAR_H }); } catch {}
  }
}

function editContextMenu(params) {
  const items = [];
  if (params.isEditable) {
    items.push(
      { role: 'undo', label: 'Отменить', enabled: params.editFlags.canUndo },
      { role: 'redo', label: 'Повторить', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать', enabled: params.editFlags.canCut },
      { role: 'copy', label: 'Копировать', enabled: params.editFlags.canCopy },
      { role: 'paste', label: 'Вставить', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'Выбрать всё' }
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    items.push({ role: 'copy', label: 'Копировать' });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

let ipcRegistered = false;
function registerIPC() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('dialog:select-directory', async (_event, defaultPath) => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите папку для вывода готовых креативов',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('shell:open-path', async (_event, p) => {
    if (p) await shell.openPath(p);
  });
  ipcMain.handle('window:set-theme', (_event, theme) => { applyChromeTheme(theme); });
  ipcMain.handle('window:show-menu', (_event, pos) => {
    const menu = Menu.getApplicationMenu();
    if (!menu || !mainWindow) return;
    menu.popup({ window: mainWindow, x: Math.round(pos?.x || 8), y: Math.round(pos?.y || TITLEBAR_H) });
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
}

function createWindow() {
  registerIPC();
  let winW = 1440, winH = 880;
  try {
    const primary = screen?.getPrimaryDisplay?.();
    if (primary?.workAreaSize) {
      winW = Math.min(1440, Math.max(1100, primary.workAreaSize.width - 40));
      winH = Math.min(900, Math.max(680, primary.workAreaSize.height - 40));
    }
  } catch {}
  const saved = SELFTEST_DIR ? null : readWindowState();
  const c = CHROME[chromeTheme];
  mainWindow = new BrowserWindow({
    width: saved?.width || winW,
    height: saved?.height || winH,
    ...(Number.isFinite(saved?.x) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1100,
    minHeight: 680,
    show: false,
    title: 'CreoMaker',
    backgroundColor: c.bg,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: c.overlay, symbolColor: c.symbol, height: TITLEBAR_H } }),
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  if (saved?.maximized) mainWindow.maximize();
  for (const ev of ['resize', 'move']) {
    let t; mainWindow.on(ev, () => { clearTimeout(t); t = setTimeout(saveWindowState, 400); });
  }
  mainWindow.on('close', saveWindowState);
  mainWindow.once('ready-to-show', () => { if (!SELFTEST_DIR || process.env.CREOMAKER_SELFTEST_SHOW !== '0') mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (origin && url.startsWith(origin)) return;
    // Never navigate away from the app (e.g. a file dropped outside the media bin): the page handles drops itself.
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  wc.on('context-menu', (_e, params) => editContextMenu(params));
  wc.on('did-finish-load', () => { try { wc.setVisualZoomLevelLimits(1, 1); } catch {} });
  wc.on('render-process-gone', (_e, details) => log('Renderer gone:', details.reason));
  wc.on('console-message', (event) => {
    const level = event.level ?? '';
    if (level === 'error' || level === 3) log('[renderer:error]', event.message);
  });
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));
}

/** macOS: an app started straight from the mounted .dmg (or a quarantined Downloads copy) vanishes from
    the Dock and is not in Applications once it quits or the disk image is ejected. Offer to move it. */
function ensureInApplicationsFolder() {
  if (!isMac || !app.isPackaged || SELFTEST_DIR) return false;
  try {
    if (app.isInApplicationsFolder()) return false;
    const fromDmg = /^\/Volumes\//.test(process.execPath);
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Переместить в «Программы»', 'Не сейчас'],
      defaultId: 0,
      cancelId: 1,
      message: 'Переместить CreoMaker в папку «Программы»?',
      detail: (fromDmg
        ? 'CreoMaker запущен прямо с установочного образа (.dmg). После закрытия или извлечения образа программа пропадёт из Dock.'
        : 'CreoMaker запущен не из папки «Программы».')
        + ' После перемещения он перезапустится, а все ваши файлы, пресеты и результаты сохранятся.'
    });
    if (choice !== 0) return false;
    // Replace an older copy that may already be in Applications.
    return app.moveToApplicationsFolder({ conflictHandler: () => true });
  } catch (error) {
    log('Move to Applications failed:', error.message);
    dialog.showErrorBox('CreoMaker', 'Не удалось переместить CreoMaker автоматически. Перетащите CreoMaker из окна установщика в папку «Программы» вручную.');
    return false;
  }
}

async function boot() {
  if (ensureInApplicationsFolder()) return; // the app relaunches from Applications
  buildMenu();
  createWindow();
  try {
    const codeDir = await ensureCode();
    const port = await pickPort();
    origin = 'http://127.0.0.1:' + port;
    const h = await startServer(codeDir, port);
    log('Server ready', origin, 'version', h.version);
    await mainWindow.loadURL(origin + '/');
    if (SELFTEST_DIR) require('./selftest.cjs').run({ app, win: mainWindow, outDir: SELFTEST_DIR, origin, tools: toolPaths(), codeDir, log, logLines, stopServer: () => { quitting = true; try { server?.kill(); } catch {} } });
  } catch (error) {
    log('Boot failed:', error.stack || error.message);
    if (SELFTEST_DIR) {
      try { fs.mkdirSync(SELFTEST_DIR, { recursive: true }); fs.writeFileSync(path.join(SELFTEST_DIR, 'report.json'), JSON.stringify({ ok: false, error: error.message, log: logLines }, null, 2)); } catch {}
      app.exit(3);
      return;
    }
    dialog.showErrorBox('CreoMaker', 'Не удалось запустить CreoMaker:\n' + error.message + '\n\nЖурнал: ' + path.join(app.getPath('userData'), 'desktop.log'));
    app.quit();
  }
}

if (!SELFTEST_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(boot);
  app.on('activate', () => { if (mainWindow) mainWindow.show(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    if (server) { try { server.kill(); } catch {} }
  });
}

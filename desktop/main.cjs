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
const { app, BrowserWindow, Menu, shell, utilityProcess, dialog, nativeTheme } = require('electron');
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
app.setPath('userData', path.join(app.getPath('appData'), 'CreoMaker Desktop'));

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
    if (meta?.commitSha && meta.commitSha === bundleInfo.commitSha || (updatedAt && bundleTime && updatedAt > bundleTime)) {
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
  const clickUpdate = () => mainWindow?.webContents.executeJavaScript("document.getElementById('cm-update-btn')?.click()").catch(() => {});
  const template = [
    ...(isMac ? [{
      label: 'CreoMaker',
      submenu: [
        { role: 'about', label: 'О программе CreoMaker' },
        { label: 'Проверить обновления…', click: clickUpdate },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть CreoMaker' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: 'Завершить CreoMaker' }
      ]
    }] : [{
      label: 'Файл',
      submenu: [
        { label: 'Проверить обновления…', click: clickUpdate },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    }]),
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
        { label: 'Папка данных CreoMaker', click: () => shell.openPath(app.getPath('userData')) },
        { label: 'Репозиторий на GitHub', click: () => shell.openExternal('https://github.com/sightless-dev/Creomaker-4') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'CreoMaker Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#07090e' : '#e9edf6',
    autoHideMenuBar: !isMac,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  mainWindow.once('ready-to-show', () => { if (!SELFTEST_DIR || process.env.CREOMAKER_SELFTEST_SHOW !== '0') mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (origin && url.startsWith(origin)) return;
    if (url.startsWith('file:')) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  wc.on('render-process-gone', (_e, details) => log('Renderer gone:', details.reason));
  wc.on('console-message', (event) => {
    const level = event.level ?? '';
    if (level === 'error' || level === 3) log('[renderer:error]', event.message);
  });
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));
}

async function boot() {
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

if (!app.requestSingleInstanceLock()) {
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

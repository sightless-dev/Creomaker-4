'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createCreoAPI } = require('./src/server/creo-api.cjs');
let { version } = require('./package.json');

const root = __dirname;
const port = Number(process.env.CREOMAKER_PORT || 4191);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Неверный CREOMAKER_PORT.');
const origin = 'http://127.0.0.1:' + port;
function buildAPI(factory = createCreoAPI) {
  return factory(root, {
    dataDir: process.env.CREO_DATA_DIR || path.join(root, 'data', 'creomaker'),
    assetRoot: process.env.CREO_ASSET_DIR ? path.resolve(process.env.CREO_ASSET_DIR) : undefined,
    onUpdated: reloadAPI
  });
}
let api = buildAPI();
function reloadAPI() {
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.join(root, 'src')) || key === path.join(root, 'package.json')) {
        delete require.cache[key];
      }
    }
    version = require('./package.json').version;
    const { createCreoAPI: freshFactory } = require('./src/server/creo-api.cjs');
    const nextApi = buildAPI(freshFactory);
    const prevApi = api;
    nextApi.ready.then(() => { api = nextApi; prevApi.close(); }).catch(() => {});
  } catch (error) {
    console.error('Ошибка перезагрузки модулей:', error.message);
  }
}
const files = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/base.css', ['public/css/base.css', 'text/css']],
  ['/creo.css', ['public/css/creo.css', 'text/css']],
  ['/standalone.js', ['public/js/standalone.js', 'text/javascript']],
  ['/creo.js', ['public/js/creo.js', 'text/javascript']],
  ['/ui-icons.js', ['public/js/ui-icons.js', 'text/javascript']],
  ['/country-search.js', ['public/js/country-search.js', 'text/javascript']],
  ['/creo-profiles.js', ['src/shared/creo-profiles.js', 'text/javascript']],
  ['/media-metadata.js', ['src/shared/media-metadata.js', 'text/javascript']],
  ['/countries.js', ['src/shared/countries.js', 'text/javascript']],
  ['/fonts/Inter-Variable.ttf', ['public/fonts/Inter-Variable.ttf', 'font/ttf']]
]);
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:' + port) {
    res.writeHead(403).end('Forbidden host');
    return;
  }
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin) return res.writeHead(403).end('Forbidden origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', csp);
    if (url.pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ service: 'CreoMaker', version, status: 'ok', port }));
      return;
    }
    if (await api.handle(req, res, url)) return;
    const entry = files.get(url.pathname);
    if (!entry || !['GET', 'HEAD'].includes(req.method)) return res.writeHead(404).end('Not found');
    const file = path.join(root, entry[0]);
    const stat = await fs.promises.stat(file);
    res.writeHead(200, {
      'Content-Type': entry[1], 'Content-Length': stat.size, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY'
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500).end('Не удалось выполнить локальную операцию.');
    else res.destroy();
  }
});

function openBrowser() {
  if (!process.argv.includes('--open')) return;
  const [command, ...args] = process.platform === 'win32'
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', origin]
    : [process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', origin];
  execFile(command, args, { windowsHide: true }, error => {
    if (error) console.error('Откройте CreoMaker в браузере · ' + origin);
  });
}

server.on('error', error => {
  if (error.code !== 'EADDRINUSE') {
    console.error(error.message);
    api.close();
    process.exitCode = 1;
    return;
  }
  const request = http.get(origin + '/api/health', { timeout: 1500 }, response => {
    let body = '';
    response.on('data', chunk => { if (body.length < 2048) body += chunk; });
    response.on('end', () => {
      let value;
      try { value = JSON.parse(body); } catch {}
      api.close();
      if (value?.service === 'CreoMaker' && value.version === version) openBrowser();
      else { console.error('Порт занят другой программой. Измените CREOMAKER_PORT.'); process.exitCode = 1; }
    });
  }).on('error', () => { api.close(); process.exitCode = 1; });
  request.on('timeout', () => request.destroy(Error('Тайм-аут проверки порта.')));
});

api.ready.then(() => server.listen(port, '127.0.0.1', () => {
  console.log('CreoMaker · ' + origin);
  openBrowser();
})).catch(error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { api.close(); server.close(); });


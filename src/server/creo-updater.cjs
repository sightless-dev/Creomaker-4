'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');

const DEFAULT_REPO = 'sightless-dev/Creomaker-4';
const DEFAULT_BRANCH = 'main';
const META_FILE = '.update-meta.json';

function getRepoConfig() {
  return {
    repo: process.env.CREOMAKER_GITHUB_REPO || DEFAULT_REPO,
    branch: process.env.CREOMAKER_GITHUB_BRANCH || DEFAULT_BRANCH,
    baseUrl: process.env.CREOMAKER_UPDATE_BASE_URL || ''
  };
}

function fetchBuffer(urlStr, { timeout = 20000, redirects = 5, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { return reject(Error('Некорректный адрес обновления.')); }
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(url, {
      timeout,
      headers: {
        'User-Agent': 'CreoMaker-Studio-Updater/1.1',
        'Accept': '*/*',
        ...headers
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(Error('Слишком много перенаправлений при проверке обновлений.'));
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(fetchBuffer(nextUrl, { timeout, redirects: redirects - 1, headers }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Error('Сервер обновлений вернул код ' + res.statusCode + '.'));
      }
      const chunks = [];
      let total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (total > 50 * 1024 * 1024) {
          req.destroy(Error('Превышен допустимый размер пакета обновления.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('Превышено время ожидания ответа от GitHub.')));
    req.on('error', err => reject(Error('Не удалось подключиться к GitHub: ' + err.message)));
  });
}

function isSafeUpdatePath(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || /[\x00-\x1f]/.test(normalized)) return false;
  const parts = normalized.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  const top = parts[0];
  if (parts.length === 1) {
    return ['package.json', 'server.cjs', 'README.md', 'start.cmd', 'Start CreoMaker.cmd', 'Start CreoMaker.command', META_FILE].includes(top);
  }
  return ['public', 'src', 'tests'].includes(top);
}

function extractZipBuffer(buf) {
  const minEocd = 22;
  if (!Buffer.isBuffer(buf) || buf.length < minEocd) throw Error('Повреждённый архив обновления.');
  const searchStart = Math.max(0, buf.length - 65557);
  let eocdPos = -1;
  for (let i = buf.length - minEocd; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw Error('Не удалось прочитать структуру ZIP-архива обновления.');
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (cdOffset + cdSize > buf.length) throw Error('Некорректный каталог ZIP-архива.');

  const files = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw Error('Повреждённая запись каталога ZIP.');
    const method = buf.readUInt16LE(pos + 10);
    const expectedCrc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    pos += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue;
    const slashIdx = rawName.indexOf('/');
    const relPath = slashIdx >= 0 ? rawName.slice(slashIdx + 1) : rawName;
    if (!isSafeUpdatePath(relPath)) continue;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw Error('Повреждённый заголовок файла в архиве: ' + relPath);
    }
    const lfhNameLen = buf.readUInt16LE(localOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw Error('Неподдерживаемый метод сжатия ZIP (' + method + ') для ' + relPath);

    if (data.length !== uncompSize) throw Error('Несовпадение размера файла ' + relPath);
    const actualCrc = zlib.crc32(data) >>> 0;
    if (actualCrc !== expectedCrc) throw Error('Ошибка контрольной суммы CRC32 для ' + relPath);

    files.push({ relPath, data });
  }
  return files;
}

async function readLocalState(root) {
  let currentVersion = '1.0.0';
  let currentSha = '';
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version) currentVersion = String(pkg.version);
  } catch {}
  try {
    const meta = JSON.parse(await fs.readFile(path.join(root, META_FILE), 'utf8'));
    if (meta.commitSha) currentSha = String(meta.commitSha);
  } catch {}
  return { currentVersion, currentSha };
}

async function fetchRemoteInfo() {
  const { repo, branch, baseUrl } = getRepoConfig();
  const rawPkgUrl = baseUrl
    ? `${baseUrl}/package.json?t=${Date.now()}`
    : `https://raw.githubusercontent.com/${repo}/${branch}/package.json?t=${Date.now()}`;
  const rawMetaUrl = baseUrl
    ? `${baseUrl}/${META_FILE}?t=${Date.now()}`
    : `https://raw.githubusercontent.com/${repo}/${branch}/${META_FILE}?t=${Date.now()}`;
  const commitApiUrl = baseUrl
    ? `${baseUrl}/commit-info.json`
    : `https://api.github.com/repos/${repo}/commits/${branch}`;

  let remoteVersion = '';
  let remoteSha = '';
  let message = '';

  const [pkgRes, commitRes, metaRes] = await Promise.allSettled([
    fetchBuffer(rawPkgUrl, { headers: { 'Cache-Control': 'no-cache' } }),
    fetchBuffer(commitApiUrl, { headers: { 'Accept': 'application/vnd.github.v3+json' } }),
    fetchBuffer(rawMetaUrl, { headers: { 'Cache-Control': 'no-cache' } })
  ]);

  if (pkgRes.status === 'fulfilled') {
    try {
      const pkg = JSON.parse(pkgRes.value.toString('utf8'));
      if (pkg.version) remoteVersion = String(pkg.version);
    } catch {}
  }
  if (commitRes.status === 'fulfilled') {
    try {
      const commit = JSON.parse(commitRes.value.toString('utf8'));
      if (commit.sha) remoteSha = String(commit.sha);
      if (commit.commit?.message) message = String(commit.commit.message).split('\n')[0].slice(0, 120);
    } catch {}
  }
  if (!remoteSha && metaRes.status === 'fulfilled') {
    try {
      const meta = JSON.parse(metaRes.value.toString('utf8'));
      if (meta.commitSha) remoteSha = String(meta.commitSha);
    } catch {}
  }

  if (!remoteVersion && !remoteSha) {
    const reason = pkgRes.status === 'rejected' ? pkgRes.reason?.message : 'нет ответа от репозитория';
    throw Error('Не удалось проверить обновления на GitHub (' + reason + ').');
  }
  return { remoteVersion, remoteSha, message, repo, branch };
}

async function checkUpdate(root) {
  const { currentVersion, currentSha } = await readLocalState(root);
  const { remoteVersion, remoteSha, message, repo } = await fetchRemoteInfo();

  const versionDiffers = Boolean(remoteVersion && remoteVersion !== currentVersion);
  const shaDiffers = Boolean(remoteSha && currentSha && remoteSha !== currentSha);
  const available = versionDiffers || shaDiffers;

  return {
    available,
    currentVersion,
    remoteVersion: remoteVersion || currentVersion,
    currentSha: currentSha ? currentSha.slice(0, 7) : '',
    remoteSha: remoteSha ? remoteSha.slice(0, 7) : '',
    message,
    repo
  };
}

async function applyUpdate(root) {
  const { repo, branch, baseUrl } = getRepoConfig();
  let remoteSha = '';
  try {
    const info = await fetchRemoteInfo();
    remoteSha = info.remoteSha;
  } catch {}

  const zipUrl = baseUrl
    ? `${baseUrl}/archive.zip`
    : `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`;
  const zipBuf = await fetchBuffer(zipUrl, { timeout: 30000 });
  const entries = extractZipBuffer(zipBuf);
  if (!entries.length || !entries.some(e => e.relPath === 'package.json')) {
    throw Error('Архив обновления с GitHub не содержит файлов приложения CreoMaker.');
  }

  let filesUpdated = 0;
  for (const entry of entries) {
    if (entry.relPath === META_FILE) continue;
    const dest = path.resolve(root, entry.relPath);
    const rel = path.relative(root, dest);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.upd-' + process.pid + '.tmp';
    await fs.writeFile(tmp, entry.data);
    if (entry.relPath.endsWith('.command')) {
      await fs.chmod(tmp, 0o755).catch(() => {});
    }
    await fs.rename(tmp, dest);
    filesUpdated++;
  }

  let newVersion = '1.1.0';
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version) newVersion = String(pkg.version);
  } catch {}

  const meta = {
    version: newVersion,
    commitSha: remoteSha || '',
    repo,
    branch,
    updatedAt: new Date().toISOString()
  };
  const metaTmp = path.join(root, META_FILE + '.tmp');
  await fs.writeFile(metaTmp, JSON.stringify(meta, null, 2));
  await fs.rename(metaTmp, path.join(root, META_FILE));

  return {
    ok: true,
    version: newVersion,
    commitSha: remoteSha ? remoteSha.slice(0, 7) : '',
    filesUpdated
  };
}

module.exports = { checkUpdate, applyUpdate, extractZipBuffer, isSafeUpdatePath };

'use strict';
/*
 * Downloads and extracts the bundled media library (video tails & background music)
 * on demand from GitHub Release "assets-v1".
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');

const ASSETS_URL = process.env.CREOMAKER_ASSETS_URL || 'https://github.com/sightless-dev/Creomaker-4/releases/download/assets-v1/CreoMaker-assets.zip';
const EXPECTED_COUNT = 39; // 26 tails + 13 music tracks

let activeDownload = null; // { promise, cancel, progress: { status, percent, receivedBytes, totalBytes, message, error } }

async function countAssets(assetRoot) {
  let count = 0;
  const seenRealPaths = new Set();
  for (const dir of ['Tails', 'tails', 'music']) {
    try {
      const full = path.join(assetRoot, dir);
      const real = await fsp.realpath(full).catch(() => null);
      if (!real || seenRealPaths.has(real.toLowerCase())) continue;
      seenRealPaths.add(real.toLowerCase());
      const entries = await fsp.readdir(full);
      count += entries.filter(n => !n.startsWith('.')).length;
    } catch {}
  }
  return count;
}

async function getStatus(assetRoot) {
  const count = await countAssets(assetRoot);
  const downloading = Boolean(activeDownload);
  const progress = activeDownload?.progress || null;
  return {
    installed: count >= 5, // At least some tails or music present
    count,
    expectedCount: EXPECTED_COUNT,
    downloading,
    progress: progress ? {
      percent: progress.percent || 0,
      receivedMB: Math.round((progress.receivedBytes || 0) / (1024 * 1024)),
      totalMB: Math.round((progress.totalBytes || 1255831204) / (1024 * 1024)),
      status: progress.status || 'downloading',
      message: progress.message || '',
      error: progress.error || ''
    } : null
  };
}

function extractZipFile(zipPath, targetDir, onEntry) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const minEocd = 22;
    if (stat.size < minEocd) throw Error('Повреждённый архив ассетов.');
    const searchStart = Math.max(0, stat.size - 65557);
    const searchBuf = Buffer.alloc(stat.size - searchStart);
    fs.readSync(fd, searchBuf, 0, searchBuf.length, searchStart);

    let eocdPos = -1;
    for (let i = searchBuf.length - minEocd; i >= 0; i--) {
      if (searchBuf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw Error('Не найден каталог ZIP-архива.');

    const totalEntries = searchBuf.readUInt16LE(eocdPos + 10);
    const cdSize = searchBuf.readUInt32LE(eocdPos + 12);
    const cdOffset = searchBuf.readUInt32LE(eocdPos + 16);

    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    let pos = 0;
    const buf16k = Buffer.alloc(64 * 1024);

    for (let i = 0; i < totalEntries; i++) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) throw Error('Повреждённая запись каталога ZIP.');
      const method = cdBuf.readUInt16LE(pos + 10);
      const expectedCrc = cdBuf.readUInt32LE(pos + 16);
      const compSize = cdBuf.readUInt32LE(pos + 20);
      const uncompSize = cdBuf.readUInt32LE(pos + 24);
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const localOffset = cdBuf.readUInt32LE(pos + 42);

      const rawName = cdBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
      pos += 46 + nameLen + extraLen + commentLen;

      if (rawName.endsWith('/')) continue;
      // Strip leading "assets/" if present, because targetDir is already the assetRoot
      let relPath = rawName.replace(/^assets\//i, '');
      const parts = relPath.split('/').filter(Boolean);
      if (parts.some(p => p === '..' || p === '.')) continue;

      const destFile = path.join(targetDir, ...parts);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });

      // Read local header to get exact data offset
      const lfh = Buffer.alloc(30);
      fs.readSync(fd, lfh, 0, 30, localOffset);
      if (lfh.readUInt32LE(0) !== 0x04034b50) throw Error('Повреждён заголовок файла: ' + relPath);
      const lfhNameLen = lfh.readUInt16LE(26);
      const lfhExtraLen = lfh.readUInt16LE(28);
      const dataOffset = localOffset + 30 + lfhNameLen + lfhExtraLen;

      if (method === 0) {
        // Store (no compression) — stream directly from fd to file
        const outFd = fs.openSync(destFile, 'w');
        try {
          let rem = compSize;
          let rPos = dataOffset;
          let crc = 0;
          while (rem > 0) {
            const chunk = Math.min(buf16k.length, rem);
            fs.readSync(fd, buf16k, 0, chunk, rPos);
            fs.writeSync(outFd, buf16k, 0, chunk);
            crc = zlib.crc32(buf16k.subarray(0, chunk), crc);
            rPos += chunk;
            rem -= chunk;
          }
          if ((crc >>> 0) !== expectedCrc) throw Error('CRC32 mismatch for ' + relPath);
        } finally {
          fs.closeSync(outFd);
        }
      } else if (method === 8) {
        // Deflate — read compressed buffer, inflateSync
        const compBuf = Buffer.alloc(compSize);
        fs.readSync(fd, compBuf, 0, compSize, dataOffset);
        const data = zlib.inflateRawSync(compBuf);
        if (data.length !== uncompSize) throw Error('Uncompressed size mismatch for ' + relPath);
        if ((zlib.crc32(data) >>> 0) !== expectedCrc) throw Error('CRC32 mismatch for ' + relPath);
        fs.writeFileSync(destFile, data);
      } else {
        throw Error('Неподдерживаемый метод сжатия (' + method + ') для ' + relPath);
      }

      if (typeof onEntry === 'function') onEntry(i + 1, totalEntries, relPath);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function startDownload(assetRoot, { onProgress, onComplete, onError } = {}) {
  if (activeDownload) return activeDownload.promise;

  const progress = {
    status: 'connecting',
    percent: 0,
    receivedBytes: 0,
    totalBytes: 1255831204, // default fallback
    message: 'Подключение к серверу обновлений…',
    error: ''
  };

  let aborted = false;
  let activeReq = null;

  function update(patch) {
    Object.assign(progress, patch);
    if (typeof onProgress === 'function') onProgress(progress);
  }

  const promise = (async () => {
    await fsp.mkdir(assetRoot, { recursive: true });
    const tmpZip = path.join(assetRoot, '.assets-download-' + process.pid + '.zip');

    try {
      update({ status: 'connecting', message: 'Запрос на скачивание библиотеки…' });

      await new Promise((resolve, reject) => {
        function get(urlStr, redirects = 5) {
          if (aborted) return reject(Error('Загрузка отменена.'));
          let url;
          try { url = new URL(urlStr); } catch { return reject(Error('Некорректный адрес ассетов.')); }
          const client = url.protocol === 'http:' ? http : https;
          activeReq = client.get(url, { headers: { 'User-Agent': 'CreoMaker-Studio/1.1' } }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
              res.resume();
              return get(new URL(res.headers.location, url).toString(), redirects - 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(Error('Сервер вернул код ' + res.statusCode + ' при скачивании библиотеки.'));
            }

            const cl = Number(res.headers['content-length']);
            if (cl > 0) progress.totalBytes = cl;

            const outStream = fs.createWriteStream(tmpZip);
            let received = 0;
            let lastUpdate = 0;

            res.on('data', chunk => {
              received += chunk.length;
              progress.receivedBytes = received;
              const now = Date.now();
              if (now - lastUpdate > 300) {
                lastUpdate = now;
                const pct = Math.min(99, Math.round((received / progress.totalBytes) * 100));
                const mb = (received / (1024 * 1024)).toFixed(1);
                const totalMb = (progress.totalBytes / (1024 * 1024)).toFixed(1);
                update({
                  status: 'downloading',
                  percent: pct,
                  receivedBytes: received,
                  message: `Скачано ${mb} МБ из ${totalMb} МБ (${pct}%)`
                });
              }
            });

            res.pipe(outStream);
            outStream.on('finish', resolve);
            outStream.on('error', reject);
            res.on('error', reject);
          });
          activeReq.on('error', reject);
        }
        get(ASSETS_URL);
      });

      if (aborted) throw Error('Загрузка отменена.');

      update({ status: 'extracting', percent: 99, message: 'Распаковка файлов в библиотеку…' });
      extractZipFile(tmpZip, assetRoot, (cur, total) => {
        update({ status: 'extracting', percent: 99, message: `Распаковка: ${cur} из ${total} файлов…` });
      });

      await fsp.unlink(tmpZip).catch(() => {});
      update({ status: 'ready', percent: 100, message: 'Библиотека успешно установлена!' });
      if (typeof onComplete === 'function') await onComplete();
    } catch (err) {
      await fsp.unlink(tmpZip).catch(() => {});
      update({ status: 'error', error: err.message, message: 'Ошибка: ' + err.message });
      if (typeof onError === 'function') onError(err);
      throw err;
    } finally {
      activeDownload = null;
    }
  })();

  activeDownload = {
    promise,
    progress,
    cancel() {
      aborted = true;
      activeReq?.destroy();
    }
  };

  return promise;
}

module.exports = { getStatus, startDownload, countAssets, EXPECTED_COUNT, extractZipFile };

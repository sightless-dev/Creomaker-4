'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createCreoAPI } = require('../src/server/creo-api.cjs');

test('output directory: default detection, custom setting and reset', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'creo-output-test-'));
  const customOut = path.join(tmpRoot, 'my-creatives');
  try {
    const api = createCreoAPI(tmpRoot, { dataDir: path.join(tmpRoot, 'data') });
    await api.ready;

    // Helper to invoke handle
    async function request(method, pathname, bodyData = null, headers = {}) {
      const url = new URL('http://127.0.0.1' + pathname);
      const reqHeaders = { host: '127.0.0.1', origin: 'http://127.0.0.1', 'x-creo-token': 'test-token', ...headers };
      let resBody = '';
      let statusCode = 200;
      let resHeaders = {};

      const req = {
        method,
        headers: reqHeaders,
        [Symbol.asyncIterator]: async function* () {
          if (bodyData) yield Buffer.from(JSON.stringify(bodyData));
        }
      };

      const res = {
        writeHead(code, h) { statusCode = code; resHeaders = h; this.headersSent = true; },
        end(data) { if (data) resBody += data; },
        write(data) { if (data) resBody += data; },
        headersSent: false,
        destroyed: false
      };

      // Mock session token
      const sessionUrl = new URL('http://127.0.0.1/api/creo/session');
      let token = '';
      await api.handle({ method: 'GET', headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' } }, {
        writeHead() {},
        end(d) { token = JSON.parse(d).token; }
      }, sessionUrl);
      req.headers['x-creo-token'] = token;

      await api.handle(req, res, url);
      return { status: statusCode, json: resBody ? JSON.parse(resBody) : null };
    }

    // 1. Initial catalog check
    const cat = await request('GET', '/api/creo/catalog');
    assert.equal(cat.status, 200);
    assert.equal(cat.json.isCustomOutput, false);
    assert.ok(cat.json.outputRoot);
    assert.equal(cat.json.outputRoot, cat.json.defaultOutputRoot);

    // 2. Set custom output directory
    const setRes = await request('POST', '/api/creo/set-output-dir', { path: customOut });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.json.ok, true);
    assert.equal(setRes.json.isCustom, true);
    assert.equal(path.resolve(setRes.json.outputRoot), path.resolve(customOut));
    assert.ok(fs.existsSync(customOut));

    // Verify config.json was written
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'config.json'), 'utf8'));
    assert.equal(path.resolve(cfg.outputDir), path.resolve(customOut));

    // 3. Catalog reflects custom output directory
    const cat2 = await request('GET', '/api/creo/catalog');
    assert.equal(cat2.json.isCustomOutput, true);
    assert.equal(path.resolve(cat2.json.outputRoot), path.resolve(customOut));

    // 4. Set custom output directory with surrounding quotes (Windows "Copy as path")
    const quotedDir = path.join(tmpRoot, 'quoted dir with spaces');
    const quotedRes = await request('POST', '/api/creo/set-output-dir', { path: `"${quotedDir}"` });
    assert.equal(quotedRes.status, 200);
    assert.equal(quotedRes.json.ok, true);
    assert.equal(path.resolve(quotedRes.json.outputRoot), path.resolve(quotedDir));
    assert.ok(fs.existsSync(quotedDir));

    // 5. Set custom output directory with Cyrillic characters
    const cyrillicDir = path.join(tmpRoot, 'Папка Креативов 2026');
    const cyrillicRes = await request('POST', '/api/creo/set-output-dir', { path: cyrillicDir });
    assert.equal(cyrillicRes.status, 200);
    assert.equal(cyrillicRes.json.ok, true);
    assert.equal(path.resolve(cyrillicRes.json.outputRoot), path.resolve(cyrillicDir));
    assert.ok(fs.existsSync(cyrillicDir));

    // 6. Attempting to set an existing file instead of directory must fail
    const dummyFile = path.join(tmpRoot, 'not-a-folder.txt');
    await fsp.writeFile(dummyFile, 'hello');
    const failRes = await request('POST', '/api/creo/set-output-dir', { path: dummyFile });
    assert.equal(failRes.status, 400);
    assert.match(failRes.json.error, /является файлом/);

    // 7. Open folder of non-existent job must fail
    const openFail = await request('POST', '/api/creo/open-folder', { id: 'non-existent-id' });
    assert.equal(openFail.status, 400);
    assert.match(openFail.json.error, /Задача не найдена/);

    // 8. Clear jobs and delete job API
    const clearRes = await request('POST', '/api/creo/clear-jobs', {});
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.json.ok, true);

    const deleteFail = await request('POST', '/api/creo/delete-job', { id: 'non-existent-id' });
    assert.equal(deleteFail.status, 400);
    assert.match(deleteFail.json.error, /Задача не найдена/);

    // 9. Reset back to default
    const resetRes = await request('POST', '/api/creo/set-output-dir', { path: '' });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.ok, true);
    assert.equal(resetRes.json.isCustom, false);
    assert.equal(path.resolve(resetRes.json.outputRoot), path.resolve(cat.json.defaultOutputRoot));

    api.close();
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

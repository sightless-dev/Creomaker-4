'use strict';
// Desktop: files are linked in place (no copy) and results go next to the source by default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { createCreoAPI } = require('../src/server/creo-api.cjs');
const { defaults } = require('../src/server/creo-engine.cjs');

const probe = { width: 320, height: 240, duration: 2, audio: true, video: true };
function stubEngine() {
  return {
    ffmpeg: __filename, ffprobe: __filename,
    async probe(file) { if (!fs.existsSync(file)) throw Error('no file'); return probe; },
    async hardware() { return { available: [], preferred: 'libx264' }; },
    async process(request, resolveMedia, outDir) {
      await fsp.mkdir(outDir, { recursive: true });
      const outputs = [];
      for (const id of request.inputs) {
        const name = path.parse(resolveMedia(id).name).name + '_out.mp4';
        await fsp.writeFile(path.join(outDir, name), 'x');
        outputs.push({ name, width: 320, height: 240, size: 1 });
      }
      return outputs;
    }
  };
}

function client(api) {
  let token = '';
  return async function request(method, route, data, rawBody) {
    if (!token) {
      await api.handle({ method: 'GET', headers: { host: '127.0.0.1' } }, { writeHead() {}, end(d) { token = JSON.parse(d).token; } }, new URL('http://127.0.0.1/api/creo/session'));
    }
    const req = Readable.from(rawBody ? [rawBody] : data ? [Buffer.from(JSON.stringify(data))] : []);
    req.method = method;
    req.headers = { host: '127.0.0.1', 'x-creo-token': token };
    let status = 200, body = '';
    const res = { writeHead(code) { status = code; this.headersSent = true; return this; }, end(d) { if (d) body += d; }, write(d) { body += d; return true; }, on() {}, headersSent: false };
    await api.handle(req, res, new URL('http://127.0.0.1/api/creo/' + route));
    return { status, json: body ? JSON.parse(body) : null };
  };
}

const waitIdle = async (request, ids) => {
  for (let i = 0; i < 100; i++) {
    const cat = await request('GET', 'catalog');
    if (ids.every(id => cat.json.jobs.find(j => j.id === id)?.status === 'completed')) return cat.json;
    await new Promise(r => setTimeout(r, 20));
  }
  throw Error('jobs did not finish');
};

test('desktop links files in place, keeps them across restarts and saves results next to the source', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'creo-linked-'));
  try {
    const dataDir = path.join(tmp, 'data');
    const srcA = path.join(tmp, 'Shoot A'), srcB = path.join(tmp, 'Shoot B');
    await fsp.mkdir(srcA); await fsp.mkdir(srcB);
    const a = path.join(srcA, 'clip-a.mp4'), b = path.join(srcB, 'clip-b.mp4');
    await fsp.writeFile(a, 'aaaa'); await fsp.writeFile(b, 'bbbb');

    let api = createCreoAPI(tmp, { dataDir, engine: stubEngine(), desktop: true });
    let request = client(api);
    const cat = await request('GET', 'catalog');
    assert.equal(cat.json.linkFiles, true);
    assert.equal(cat.json.outputMode, 'beside', 'desktop saves next to the source by default');

    const la = await request('POST', 'link', { kind: 'inputs', path: a });
    assert.equal(la.status, 201);
    assert.equal(la.json.linked, true);
    assert.equal(la.json.location, a);
    assert.equal(la.json.missing, false);
    assert.deepEqual(await fsp.readdir(path.join(dataDir, 'uploads')), [], 'nothing is copied');
    const again = await request('POST', 'link', { kind: 'inputs', path: a });
    assert.equal(again.json.id, la.json.id, 'linking the same file twice reuses the entry');
    const lb = await request('POST', 'link', { kind: 'inputs', path: b });

    assert.equal((await request('POST', 'link', { kind: 'inputs', path: 'relative.mp4' })).status, 400);
    assert.equal((await request('POST', 'link', { kind: 'music', path: a })).status, 400, 'wrong group is rejected');
    assert.equal((await request('POST', 'link', { kind: 'inputs', path: path.join(srcA, 'nope.mp4') })).status, 400);

    // One source folder: one job, results in <source>/CreoMaker/<job>.
    const settings = { ...defaults, mode: 'unique', copies: 1 };
    const single = await request('POST', 'jobs', { settings, inputs: [la.json.id], tails: [], intros: [], music: [], tailMusic: [], edits: {} });
    assert.equal(single.status, 202);
    assert.equal(single.json.split, 1);
    assert.equal(path.dirname(single.json.outputDir), path.join(srcA, 'CreoMaker'));
    // Two source folders: split into two jobs, each next to its own source.
    const split = await request('POST', 'jobs?queue=1', { settings, inputs: [la.json.id, lb.json.id], tails: [], intros: [], music: [], tailMusic: [], edits: {} });
    assert.equal(split.status, 202);
    assert.equal(split.json.split, 2);
    const done = await waitIdle(request, [single.json.id, split.json.id]);
    const dirs = done.jobs.filter(j => j.id !== single.json.id).map(j => path.dirname(j.outputDir)).sort();
    assert.deepEqual(dirs, [path.join(srcA, 'CreoMaker'), path.join(srcB, 'CreoMaker')]);
    assert.ok(fs.existsSync(path.join(single.json.outputDir, 'clip-a_out.mp4')));

    // Switch back to the output folder.
    assert.equal((await request('POST', 'set-output-mode', { mode: 'folder' })).json.outputMode, 'folder');
    const inFolder = await request('POST', 'jobs', { settings, inputs: [la.json.id], tails: [], intros: [], music: [], tailMusic: [], edits: {} });
    assert.equal(path.dirname(inFolder.json.outputDir), path.resolve(done.outputRoot));
    await waitIdle(request, [inFolder.json.id]);
    await request('POST', 'set-output-mode', { mode: 'beside' });

    // A moved file is kept, marked missing, refused for processing and can be pointed to again.
    const moved = path.join(srcB, 'clip-a-renamed.mp4');
    await fsp.rename(a, moved);
    api.close?.();
    api = createCreoAPI(tmp, { dataDir, engine: stubEngine(), desktop: true });
    request = client(api);
    const after = await request('GET', 'catalog');
    assert.equal(after.json.outputMode, 'beside', 'mode survives a restart');
    const entry = after.json.media.find(m => m.id === la.json.id);
    assert.equal(entry.missing, true);
    const refused = await request('POST', 'jobs', { settings, inputs: [la.json.id], tails: [], intros: [], music: [], tailMusic: [], edits: {} });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /не найден/);
    const relinked = await request('POST', 'relink', { id: la.json.id, path: moved });
    assert.equal(relinked.json.missing, false);
    assert.equal(relinked.json.location, moved);
    assert.equal(relinked.json.name, 'clip-a-renamed.mp4');
    api.close?.();
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('browser build never accepts paths; copied files can be deleted to free space', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'creo-linked-'));
  try {
    const dataDir = path.join(tmp, 'data'), src = path.join(tmp, 'clip.mp4');
    await fsp.writeFile(src, 'data');
    const api = createCreoAPI(tmp, { dataDir, engine: stubEngine(), desktop: false });
    const request = client(api);
    const cat = await request('GET', 'catalog');
    assert.equal(cat.json.linkFiles, false);
    assert.equal(cat.json.outputMode, 'folder');
    assert.equal((await request('POST', 'link', { kind: 'inputs', path: src })).status, 400);
    assert.equal((await request('POST', 'set-output-mode', { mode: 'beside' })).status, 400);

    const up = await request('POST', 'upload?kind=inputs&name=clip.mp4', null, Buffer.from('12345'));
    assert.equal(up.status, 201);
    assert.equal((await fsp.readdir(path.join(dataDir, 'uploads'))).length, 1);
    const gone = await request('POST', 'forget-media', { ids: [up.json.id] });
    assert.deepEqual(gone.json, { ok: true, removed: 1, freed: 5 });
    assert.deepEqual(await fsp.readdir(path.join(dataDir, 'uploads')), []);
    assert.ok(fs.existsSync(src), 'the original is never touched');
    assert.equal((await request('GET', 'catalog')).json.media.some(m => m.id === up.json.id), false);
    api.close?.();
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

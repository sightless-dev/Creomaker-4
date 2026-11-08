'use strict';
/*
 * Prepares desktop/bundle/ for electron-builder:
 *   bundle/app-code  – the same code that the browser build and the GitHub updater use
 *   bundle/bin       – FFmpeg + FFprobe for the target platform/arch
 *   bundle/assets    – bundled tails / music library
 *
 * Usage: node scripts/prepare-bundle.cjs --platform win|mac --arch x64|arm64 [--assets <dir>] [--tools <dir>]
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const platform = args.platform || (process.platform === 'darwin' ? 'mac' : 'win');
const arch = args.arch || process.arch;
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const bundle = path.join(desktopDir, 'bundle');
const CODE_ENTRIES = ['public', 'src', 'tests', 'server.cjs', 'package.json', 'README.md'];
const FFMPEG_STATIC = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/';

function git(...a) { try { return execFileSync('git', a, { cwd: repoRoot }).toString().trim(); } catch { return ''; } }

function download(url, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CreoMaker-Desktop-Build' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(Error(url + ' → HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function copyIfChanged(from, to) {
  const a = await fsp.stat(from);
  const b = await fsp.stat(to).catch(() => null);
  if (b && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  await fsp.utimes(to, a.atime, a.mtime);
  return true;
}

async function syncDir(from, to) {
  await fsp.mkdir(to, { recursive: true });
  const want = new Set();
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    want.add(entry.name);
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) await syncDir(src, dst);
    else if (entry.isFile()) await copyIfChanged(src, dst);
  }
  for (const entry of await fsp.readdir(to)) if (!want.has(entry)) await fsp.rm(path.join(to, entry), { recursive: true, force: true });
}

async function prepareCode() {
  const out = path.join(bundle, 'app-code');
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });
  for (const entry of CODE_ENTRIES) {
    const from = path.join(repoRoot, entry);
    if (fs.existsSync(from)) await fsp.cp(from, path.join(out, entry), { recursive: true });
  }
  const pkg = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const commitSha = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
  const commitTime = git('log', '-1', '--format=%cI', commitSha) || new Date().toISOString();
  const meta = { version: pkg.version, commitSha, repo: 'sightless-dev/Creomaker-4', branch: 'main', updatedAt: commitTime };
  await fsp.writeFile(path.join(out, '.update-meta.json'), JSON.stringify(meta, null, 2));
  const bundleInfo = { buildId: commitSha.slice(0, 12) + '-' + Date.now(), commitSha, commitTime, version: pkg.version, platform, arch };
  await fsp.writeFile(path.join(out, '.desktop-bundle.json'), JSON.stringify(bundleInfo, null, 2));
  console.log('app-code ready · v' + pkg.version + ' · ' + commitSha.slice(0, 7));
}

async function prepareTools() {
  const out = path.join(bundle, 'bin');
  await fsp.mkdir(out, { recursive: true });
  for (const f of await fsp.readdir(out)) await fsp.rm(path.join(out, f), { recursive: true, force: true });
  if (platform === 'win') {
    const tools = path.resolve(args.tools || path.join(repoRoot, 'tools'));
    let hasLocal = true;
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      if (!fs.existsSync(path.join(tools, name))) { hasLocal = false; break; }
    }
    if (hasLocal) {
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        await fsp.copyFile(path.join(tools, name), path.join(out, name));
      }
      for (const lic of ['GPL-3.0.txt', 'FFPROBE-LICENSE.txt', 'THIRD_PARTY.md']) {
        if (fs.existsSync(path.join(tools, lic))) await fsp.copyFile(path.join(tools, lic), path.join(out, lic));
      }
    } else {
      for (const tool of ['ffmpeg', 'ffprobe']) {
        const file = tool + '-win32-x64.gz';
        console.log('Downloading ' + file + ' …');
        const gz = await download(FFMPEG_STATIC + file);
        await fsp.writeFile(path.join(out, tool + '.exe'), zlib.gunzipSync(gz));
      }
    }
  } else {
    const sums = Object.fromEntries((await fsp.readFile(path.join(desktopDir, 'vendor', 'SHA256SUMS'), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(l => l.trim().split(/\s+/)).map(([h, f]) => [f, h]));
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const file = tool + '-darwin-' + arch + '.gz';
      console.log('Downloading ' + file + ' …');
      const gz = await download(FFMPEG_STATIC + file);
      const hash = crypto.createHash('sha256').update(gz).digest('hex');
      if (hash !== sums[file]) throw Error('Контрольная сумма не совпала: ' + file + ' (' + hash + ')');
      await fsp.writeFile(path.join(out, tool), zlib.gunzipSync(gz), { mode: 0o755 });
      await fsp.chmod(path.join(out, tool), 0o755);
    }
    for (const f of await fsp.readdir(path.join(desktopDir, 'vendor', 'licenses'))) {
      await fsp.copyFile(path.join(desktopDir, 'vendor', 'licenses', f), path.join(out, f));
    }
  }
  console.log('bin ready · ' + (await fsp.readdir(out)).join(', '));
}

async function prepareAssets() {
  const out = path.join(bundle, 'assets');
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });
  if (args.assets && args.assets !== 'none' && args.assets !== 'skip') {
    const source = path.resolve(desktopDir, args.assets);
    if (fs.existsSync(source) && (await fsp.readdir(source)).length) {
      // Accept both "<dir>/Tails" and "<dir>/assets/Tails" layouts.
      const inner = fs.existsSync(path.join(source, 'assets')) ? path.join(source, 'assets') : source;
      await syncDir(inner, out);
      console.log('assets ready · ' + (await fsp.readdir(out)).join(', '));
      return;
    }
  }
  await fsp.writeFile(path.join(out, 'README.txt'), 'Bundled library is downloaded on demand inside the application.\n');
  console.log('assets skipped (on-demand download enabled)');
}

(async () => {
  console.log('Preparing desktop bundle · ' + platform + ' · ' + arch);
  await prepareCode();
  await prepareTools();
  await prepareAssets();
})().catch(error => { console.error(error.message); process.exit(1); });

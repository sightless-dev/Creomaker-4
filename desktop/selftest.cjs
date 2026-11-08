'use strict';
/*
 * Packaged-app self-test (used by CI on real macOS runners and locally on Windows).
 * Enabled only when CREOMAKER_SELFTEST=<output dir> is set. It drives the real UI,
 * captures screenshots and writes report.json, then quits.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run({ app, win, outDir, origin, tools, codeDir, log, logLines, stopServer }) {
  fs.mkdirSync(outDir, { recursive: true });
  const report = { ok: true, platform: process.platform, arch: process.arch, versions: process.versions, origin, codeDir, checks: [], screenshots: [] };
  const hardStop = setTimeout(() => { report.ok = false; report.error = 'timeout'; finish(4); }, 240000);
  const js = code => win.webContents.executeJavaScript(code, true);
  const check = (name, pass, detail = '') => { report.checks.push({ name, pass: !!pass, detail }); if (!pass) report.ok = false; log('[selftest]', pass ? 'PASS' : 'FAIL', name, detail); };
  const shot = async name => {
    await sleep(700);
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, name + '.png');
    fs.writeFileSync(file, image.toPNG());
    report.screenshots.push(name + '.png');
  };
  function finish(code) {
    clearTimeout(hardStop);
    report.log = logLines.slice(-200);
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    try { stopServer?.(); } catch {}
    app.exit(code);
  }

  try {
    win.setSize(1440, 900);
    win.center();

    // 1. Native tools inside the bundle.
    try {
      execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:duration=1', '-frames:v', '5', '-c:v', 'libx264', '-f', 'null', '-'], { timeout: 60000 });
      check('ffmpeg H.264 encode', true, tools.ffmpeg);
    } catch (e) { check('ffmpeg H.264 encode', false, String(e.message).slice(0, 300)); }
    try {
      const v = execFileSync(tools.ffprobe, ['-version'], { timeout: 30000 }).toString().split('\n')[0];
      check('ffprobe runs', true, v);
    } catch (e) { check('ffprobe runs', false, String(e.message).slice(0, 300)); }

    // 2. UI loaded and catalog connected (wait until #cm-ffmpeg updates from initial "Локальный обработчик").
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await js("(() => { const el = document.getElementById('cm-ffmpeg'); return !!window.CreoMaker && !!el && el.textContent.trim() !== '' && el.textContent.trim() !== 'Локальный обработчик'; })()");
      if (!ready) await sleep(500);
    }
    check('UI connected to local server', ready);
    const ff = await js("document.getElementById('cm-ffmpeg').textContent");
    check('Server sees FFmpeg', /готов/i.test(ff), ff);
    const lib = await js("({tails: document.querySelectorAll('#cm-tails-list [data-track-id]').length, music: document.querySelectorAll('#cm-music-list [data-track-id]').length, tailMusic: document.querySelectorAll('#cm-tailMusic-list [data-track-id]').length})");
    report.library = lib;
    const hasAssets = (lib.tails + lib.music + lib.tailMusic) > 0;
    check('Bundled library status', true, hasAssets ? 'Вшитая библиотека подключена (' + JSON.stringify(lib) + ')' : 'Сборка без вшитых ассетов (пользовательские файлы подключаются вручную)');
    const fontOk = await js("document.fonts.ready.then(() => [...document.fonts].some(f => /inter/i.test(f.family) && f.status === 'loaded'))");
    check('Inter font loaded', fontOk);

    const layout = async label => {
      const r = await js(`(() => {
        const vw = document.documentElement.clientWidth;
        const over = [...document.querySelectorAll('header, button, .panel, .cm-track, label')]
          .filter(el => { const b = el.getBoundingClientRect(); return b.width && b.right > vw + 2; })
          .slice(0, 8).map(el => (el.id ? '#' + el.id : el.className || el.tagName).toString().slice(0, 60));
        return { scrollW: document.documentElement.scrollWidth, vw, over };
      })()`);
      check('No horizontal overflow · ' + label, r.scrollW <= r.vw + 2 && !r.over.length, JSON.stringify(r));
    };

    // 3. Screens.
    await js("document.documentElement.dataset.theme = 'light'");
    await shot('01-clean-light');
    await layout('clean light');

    await js("document.documentElement.dataset.theme = 'dark'");
    await shot('02-clean-dark');

    await js("document.querySelector('[data-cm-mode=\"unique\"]')?.click()");
    await sleep(600);
    await shot('03-unique-dark');
    await layout('unique dark');

    await js("document.querySelector('[data-cm-mode=\"clean\"]')?.click()");
    await js("(() => { const l = document.getElementById('cm-library'); if (l) { l.open = true; document.querySelectorAll('.cm-layers-grid > details').forEach(d => d.open = true); l.scrollIntoView({ block: 'start' }); } })()");
    await shot('04-library');

    // 4. Tail video preview opens a visible dialog and closes again.
    if (lib.tails) {
      await js("document.querySelector('#cm-tails-list [data-play-track]').click()");
      await sleep(2500);
      const p = await js("(() => { const d = document.getElementById('cm-player-dialog'), v = document.getElementById('cm-player'); const b = d.getBoundingClientRect(); return { open: d.open, visible: b.width > 50 && b.height > 50, w: v.videoWidth, h: v.videoHeight, err: v.error && v.error.code, t: v.currentTime }; })()");
      check('Tail preview dialog visible', p.open && p.visible, JSON.stringify(p));
      check('Tail video decodes', p.w > 0 && !p.err, JSON.stringify(p));
      await shot('05-tail-player');
      await js("document.getElementById('cm-player-close').click()");
      await sleep(400);
      const closed = await js("!document.getElementById('cm-player-dialog').open");
      check('Tail preview closes', closed);
    }

    // 5. Music preview plays inline and does not block the page.
    if (lib.music > 1) {
      await js("document.querySelectorAll('#cm-music-list [data-play-track]')[0].click()");
      await sleep(1500);
      const first = await js("document.querySelectorAll('#cm-music-list [data-play-track]')[0].classList.contains('is-playing')");
      await js("document.querySelectorAll('#cm-music-list [data-play-track]')[1].click()");
      await sleep(1500);
      const state = await js("(() => { const b = document.querySelectorAll('#cm-music-list [data-play-track]'); return { a: b[0].classList.contains('is-playing'), b: b[1].classList.contains('is-playing'), modal: !!document.querySelector('dialog[open]') }; })()");
      check('Music plays inline (no modal)', first && !state.modal, JSON.stringify({ first, ...state }));
      check('Switching music track works', !state.a && state.b, JSON.stringify(state));
      await shot('06-music-inline');
      await js("document.querySelectorAll('#cm-music-list [data-play-track]')[1].click()");
    }

    // 6. Updater wiring (talks to GitHub).
    await js("window.scrollTo(0, 0); document.getElementById('cm-update-btn')?.click()");
    let upd = '';
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      upd = await js("document.getElementById('cm-status').textContent");
      if (/актуальн|доступно обновление|не удалось/i.test(upd)) break;
    }
    // A confirmation dialog may be open if the bundle is older than main — close it.
    await js("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
    check('Update check responds', /актуальн|доступно обновление/i.test(upd), upd);
    await shot('07-update-check');

    await js("document.documentElement.dataset.theme = 'light'");
    win.setSize(1100, 720);
    await sleep(800);
    await shot('08-small-window');
    await layout('small window 1100x720');
  } catch (error) {
    report.ok = false;
    report.error = error.stack || error.message;
  }
  finish(report.ok ? 0 : 1);
}

module.exports = { run };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Engine } = require('../src/server/creo-engine.cjs');
const { chromium } = require(process.env.CREO_BROWSER_PACKAGES ? path.join(process.env.CREO_BROWSER_PACKAGES, 'playwright') : 'playwright');

const root = path.resolve(__dirname, '..');
const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creomaker-web-'));
  const assets = path.join(temp, 'assets');
  const data = path.join(temp, 'data');
  const music = path.join(assets, 'music'), tails = path.join(assets, 'Tails');
  await Promise.all([music, tails].map(folder => fs.mkdir(folder, { recursive: true })));
  const engine = new Engine(root);
  const fixture = path.join(temp, 'fixture.mp4');
  await engine.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', fixture]);
  await engine.run('ffmpeg', ['-y', '-i', fixture, '-vn', path.join(music, 'track.m4a')]);
  await fs.copyFile(fixture, path.join(tails, 'tail.mp4'));
  await fs.copyFile(fixture, path.join(music, 'ignore-video.mp4'));
  const pending = { id: 'pending-fixture', status: 'running', createdAt: '2000-01-01', mode: 'unique', progress: .9, logs: [], outputs: [{ name: '001_old.mp4', verification: { status: 'pending' } }] };
  await fs.mkdir(path.join(data, 'results', pending.id), { recursive: true });
  await fs.writeFile(path.join(data, 'results', pending.id, 'job.json'), JSON.stringify(pending));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, CREOMAKER_PORT: String(port), CREO_DATA_DIR: data, CREO_ASSET_DIR: assets },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const external = [], errors = [];
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await fetch(base + '/api/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, log);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
    await page.goto(base);
    await page.locator('#cm-ffmpeg').filter({ hasText: 'готов' }).waitFor();
    assert.equal(await page.locator('#cm-advanced').evaluate(el => el.open), false);
    assert.equal(await page.locator('#cm-preview-empty').isVisible(), true);
    assert.equal(await page.locator('#cm-delivery-link').count(), 0);
    assert.equal(await page.locator('#cm-preset-options').isVisible(), true);
    assert.equal(await page.locator('#cm-preset-bar').isVisible(), false);
    assert.equal(await page.locator('#cm-preset-manage').isVisible(), false);
    assert.equal(await page.locator('input[type=search], [data-cm-filter], #cm-import-project, #cm-export-project').count(), 0);
    assert.ok(await page.locator('#cm-country option').count() > 200);
    assert.equal(await page.locator('#cm-run').isDisabled(), true);
    await fs.mkdir(path.join(root, '.build/shots'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.build/shots/creomaker-start.png') });
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await page.locator('#cm-editor').isVisible(), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual(await page.locator('#cm-formats input:checked').evaluateAll(inputs => inputs.map(input => input.dataset.format)), ['9:16', '1:1']);
    const tracks = page.locator('#cm-music-list [data-track-id]');
    assert.equal(await tracks.count(), 1);
    assert.equal(await page.locator('#cm-tails-list [data-track-id]').count(), 1);
    await fs.copyFile(path.join(music, 'track.m4a'), path.join(music, 'new-track.m4a'));
    await page.locator('#cm-goto-library').click();
    const layers = await page.locator('.cm-layers-grid > .panel').evaluateAll(cards => cards.map(card => {
      const rect = card.getBoundingClientRect();
      return { width: rect.width, height: rect.height, top: rect.top };
    }));
    assert.ok(layers.every(card => Math.abs(card.width - layers[0].width) < 1 && card.height === layers[0].height && card.top === layers[0].top));
    await page.locator('#theme-toggle').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(root, '.build/shots/creomaker-dark-clean.png') });
    await page.locator('#theme-toggle').click();
    await page.locator('#cm-music-list').locator('..').locator('summary').click();
    await page.locator('#cm-library-refresh').click();
    await tracks.nth(1).waitFor();
    assert.equal(await tracks.locator('input:checked').count(), 1);
    assert.equal(await page.locator('#creo-view').isVisible(), true);
    assert.equal(await page.locator('#vault-view').count(), 0);
    assert.equal((await page.request.get(base + '/api/creative/session')).status(), 404);
    assert.equal((await page.request.get(base + '/src/server/creo-engine.cjs')).status(), 404);
    assert.equal((await page.request.get(base + '/data/creomaker/library.json')).status(), 404);
    assert.equal((await page.request.get(base + '/api/creo/catalog')).status(), 401);
    await page.locator('#cm-pick-inputs').setInputFiles(fixture);
    await page.locator('#cm-files [data-media-id]').waitFor();
    await page.locator('#cm-frame').waitFor();
    assert.equal(await page.locator('#cm-preview-empty').isVisible(), false);
    assert.equal(await page.locator('.cm-source-tools').count(), 0);
    assert.equal(await page.locator('#cm-source-actions button').count(), 2);
    await page.locator('#cm-empty-list').click();
    await page.locator('#cm-files [data-media-id]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#cm-run').isDisabled(), true);
    const trash = await page.locator('#cm-empty-list').boundingBox();
    const restore = await page.locator('#cm-restore-list').boundingBox();
    assert.equal(trash.y, restore.y);
    assert.equal(trash.height, restore.height);
    await page.locator('#cm-restore-list').click();
    await page.locator('#cm-files input[type=checkbox]').check();
    assert.equal(await page.locator('#cm-run').isEnabled(), true);
    await page.locator('#cm-files [data-select-file]').click();
    await page.locator('#cm-frame').waitFor();
    await page.locator('#cm-edit-controls > summary').click();
    assert.equal(await page.locator('#cm-start').isVisible(), true);
    await page.locator('#cm-edit-controls > summary').click();
    await page.locator('button[data-cm-mode=unique]').click();
    assert.equal(await page.locator('#cm-preset-options [data-cm-profile]:visible').count(), 4);
    assert.equal(await page.locator('#cm-preset-options #cm-unique-settings').count(), 1);
    assert.equal(await page.locator('#cm-advanced').evaluate(el => el.open), false);
    await page.locator('[data-cm-profile=light]').click();
    await page.locator('#cm-unique-settings > summary').click();
    const noise = page.locator('[data-cm-setting=uniqueNoise]');
    assert.equal(await noise.inputValue(), '2');
    await page.locator('#cm-preset-save').click();
    await page.locator('#cm-preset-name').fill('Fixture profile');
    await page.locator('#cm-preset-confirm').click();
    assert.equal(await page.locator('#cm-preset-bar').isVisible(), true);
    assert.equal(await page.locator('#cm-preset-manage').isVisible(), true);
    await page.locator('[data-cm-profile=medium]').click();
    assert.equal(await noise.inputValue(), '4');
    await page.locator('#cm-preset-apply').click();
    assert.equal(await noise.inputValue(), '2');
    assert.equal(await page.locator('.cm-settings > :nth-child(2)').getAttribute('id'), 'cm-copy-control');
    assert.equal(await page.locator('#cm-copy-value').textContent(), '1');
    await page.locator('#cm-copy-count').click();
    await page.locator('#cm-copy-count-input').fill('2');
    await page.locator('#cm-copy-count-form button[type=submit]').click();
    assert.equal(await page.locator('#cm-copy-value').textContent(), '2');
    await page.locator('#cm-undo').click();
    assert.equal(await page.locator('#cm-copy-value').textContent(), '1');
    await page.locator('#cm-advanced > summary').click();
    await page.locator('.cm-gpu-settings > summary').click();
    await page.locator('#cm-acceleration').selectOption('cpu');
    await page.locator('.cm-metadata-settings > summary').click();
    await page.locator('#cm-meta-details > summary').click();
    await page.locator('[data-meta-field=artist]').fill('Fixture author');
    await page.locator('#cm-meta-generate').click();
    const firstTitle = await page.locator('#cm-metadata-title').inputValue();
    await page.locator('#cm-meta-generate').click();
    const title = await page.locator('#cm-metadata-title').inputValue();
    assert.match(title, /^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z2-9]{6}$/);
    assert.notEqual(firstTitle, title);
    assert.equal(await page.locator('[data-meta-field=artist]').inputValue(), 'Fixture author');
    await page.locator('#cm-run').click();
    await page.locator('#cm-results .cm-verification-verified, #cm-results .cm-verification-warning').waitFor({ timeout: 60000 });
    await page.locator('#cm-run-feedback').filter({ hasText: 'Готово' }).waitFor();
    assert.equal(await page.locator('#cm-status').textContent(), '');
    await page.locator('#cm-results .cm-verification summary').click();
    assert.ok(await page.locator('#cm-results').getByText('SHA-256 исходника', { exact: false }).count());
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#cm-results a').filter({ hasText: 'Скачать отчёт JSON' }).click();
    const download = await downloadEvent;
    const report = JSON.parse(await fs.readFile(await download.path()));
    assert.equal(report.output.fps, 25);
    assert.notEqual(report.source.sha256, report.output.sha256);
    assert.ok(report.checks.some(check => check.id === 'spectrum'));
    const token = (await (await page.request.get(base + '/api/creo/session')).json()).token;
    const headers = { 'X-Creo-Token': token };
    const catalog = await (await page.request.get(base + '/api/creo/catalog', { headers })).json();
    assert.equal(catalog.jobs.find(job => job.id === pending.id).status, 'interrupted');
    assert.equal(catalog.jobs.find(job => job.id === pending.id).outputs[0].verification.status, 'unavailable');
    const job = catalog.jobs.find(job => job.outputs.some(output => output.verification?.report));
    assert.ok(job);
    const file = path.join(data, 'results', job.id, job.outputs[0].name);
    const metadata = JSON.parse(await engine.run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title,artist,keywords', '-of', 'json', file]));
    assert.equal(metadata.format.tags.title, title);
    assert.equal(metadata.format.tags.artist, 'Fixture author');
    assert.match(metadata.format.tags.keywords, /creative variant/);
    assert.equal((await page.request.get(base + '/api/creo/verification?job=' + job.id + '&name=../secret', { headers })).status(), 400);
    await page.locator('#cm-advanced > summary').click();
    await page.locator('#cm-delivery').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#cm-delivery').isVisible(), true);
    assert.equal(await page.locator('#cm-retry-job').isVisible(), false);
    await page.locator('.cm-log-details > summary').click();
    assert.equal(await page.locator('#cm-retry-job').isVisible(), true);
    await page.locator('.cm-log-details > summary').click();
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await page.locator('#cm-stage').isVisible(), false);
    await page.locator('#cm-preview-toggle').click();
    assert.equal(await page.locator('#cm-preview-toggle').getAttribute('aria-expanded'), 'true');
    await page.locator('#cm-frame').waitFor();
    await page.locator('#cm-preview-toggle').click();
    assert.equal(await page.locator('#cm-stage').isVisible(), false);
    await page.locator('#cm-unique-settings > summary').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(root, '.build/shots/creomaker-mobile-ready.png') });
    await page.locator('#cm-unique-settings > summary').click();
    for (const width of [1440, 1151, 1024, 880, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'overflow at ' + width);
      const button = await page.locator('#cm-copy-count').boundingBox();
      const output = await page.locator('.cm-settings').boundingBox();
      const files = await page.locator('.cm-sources').boundingBox();
      const preview = await page.locator('.cm-editor').boundingBox();
      if (width > 880) {
        assert.ok(files.x + files.width <= preview.x && files.y === preview.y && files.height === preview.height, 'aligned file and preview panels at ' + width);
      }
      if (width > 1150) {
        assert.ok(preview.x + preview.width <= output.x && preview.y === output.y && preview.height === output.height, 'aligned output panel at ' + width);
      } else {
        assert.ok(preview.y + preview.height <= output.y, 'output below preview at ' + width);
      }
      assert.ok(button.width >= 190 && button.y >= output.y && button.y - output.y < 95, 'copies first in output at ' + width);
      assert.equal(await page.locator('.cm-launch').evaluate(el => getComputedStyle(el).position), 'static');
      const rows = await page.locator('#cm-unique-fields > label').evaluateAll(labels => labels.map(label => ({
        left: label.getBoundingClientRect().left,
        top: label.getBoundingClientRect().top,
        glyph: label.querySelector('svg').innerHTML
      })));
      assert.ok(rows.every((row, i) => row.left === rows[0].left && (i === 0 || row.top > rows[i - 1].top)));
      assert.equal(new Set(rows.map(row => row.glyph)).size, rows.length);
      await page.screenshot({ path: path.join(root, '.build/shots', 'creomaker-' + width + '.png'), fullPage: false });
    }
    await page.locator('#theme-toggle').click();
    await page.screenshot({ path: path.join(root, '.build/shots/creomaker-dark-320.png') });
    await page.reload();
    await page.locator('#cm-ffmpeg').filter({ hasText: 'готов' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('button[data-cm-mode=unique]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#cm-copy-value').textContent(), '1');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log('PASS compact preview, visible built-in presets, saved preset apply, local completion feedback and export, 320–1440');
  } finally {
    await browser.close();
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });


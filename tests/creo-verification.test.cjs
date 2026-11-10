'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Engine, config, processingSettings } = require('../src/server/creo-engine.cjs');
const Verification = require('../src/server/creo-verification.cjs');
const root = path.resolve(__dirname, '..');

test('Automatic frame rate and new settings respect explicit choices', () => {
  assert.equal(processingSettings(config({ mode: 'unique' }), { frameRate: 30 }).outputFps, 25);
  assert.equal(processingSettings(config({ mode: 'unique' }), { frameRate: 25 }).outputFps, 30);
  assert.equal(processingSettings(config({ mode: 'unique', outputFps: 24 }), { frameRate: 30 }).outputFps, 24);
  assert.equal(processingSettings(config({ mode: 'clean', tailmix: false }), { frameRate: 30 }).outputFps, 0);
  for (const settings of [{ signalLevel: 500 }, { signalPitch: 10 }, { signalCrop: 10 }, { outputFps: 8 }]) assert.throws(() => config(settings));
});

test('Spectral analysis includes high audio frequencies', () => {
  const samples = Buffer.alloc(17640 * 4);
  for (let i = 0; i < 17640; i++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 10000 * i / 44100) * 8000);
    samples.writeInt16LE(sample, i * 4);
    samples.writeInt16LE(sample, i * 4 + 2);
  }
  const result = Verification.audioFeatures([samples]);
  assert.equal(result.audible, true);
  assert.ok(Math.abs(result.centroidHz - 10000) < 30);
  assert.ok(result.bands[7] > .98);
});

test('Real FFmpeg verifies variants, tails, identical files, silence and cancellation', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'creomaker-verification-'));
  const engine = new Engine(root);
  const source = path.join(dir, 'source.mp4');
  const tail = path.join(dir, 'tail.mp4');
  const silent = path.join(dir, 'silent.mp4');
  await engine.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1.6', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=1.6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source]);
  await engine.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=red:size=160x120:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=900:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', tail]);
  await engine.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=black:size=160x120:rate=30:duration=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', silent]);
  const media = [source, tail, silent].map((file, index) => ({ id: String(index), name: path.basename(file), path: file }));
  const resolve = id => media.find(item => item.id === id);
  const base = { acceleration: 'cpu', preset: 'ultrafast', threads: 1, copies: 1, pitch: 0, speed: 0, formats: ['1:1'] };
  const request = { inputs: ['0'], tails: ['1'], music: [], tailMusic: [], edits: {} };
  const reportDir = path.join(dir,'reports');
  const variants = await engine.process({ ...request, settings: { ...base, mode: 'unique' } }, resolve, path.join(dir, 'variants'), {reportDir});
  const result = variants[0].verification;
  assert.ok(result, 'Each processed video has measured verification');
  const check = id => result.checks.find(item => item.id === id);
  for (const id of ['sha256', 'metadata', 'video', 'fps', 'audio', 'spectrum', 'amplitude']) assert.equal(check(id).state, 'changed', id + ': ' + JSON.stringify(check(id)));
  assert.notEqual(result.sourceSha256, result.outputSha256);
  assert.deepEqual(await fs.readdir(path.join(dir,'variants')),[variants[0].name]);
  const report = JSON.parse(await fs.readFile(path.join(reportDir, result.report)));
  assert.equal(report.source.fps, 30);
  assert.equal(report.output.fps, 25);
  assert.equal(report.source.sampleTimes.length, 4);
  assert.equal(report.output.audio.bands.length, 8);
  assert.ok(report.output.metadataKeys.includes('creomaker_processing_id'));
  assert.equal('tags' in report.source, false, 'Reports hold tag hashes/keys, not private tag values');
  const tails = await engine.process({ ...request, settings: { ...base, mode: 'clean', tailSeconds: 1, fade: .1 } }, resolve, path.join(dir, 'tails'));
  assert.equal(tails[0].verification.checks.find(item => item.id === 'tails').state, 'changed');
  assert.equal(tails[0].verification.checks.find(item => item.id === 'fps').state, 'changed');
  assert.equal(tails[0].verification.checks.find(item => item.id === 'composition').state, 'changed');
  const cleanAudioOnly = await engine.process({ inputs: ['2'], tails: [], music: [{ id: '0', volume: 80 }], tailMusic: [], edits: {}, settings: { ...base, mode: 'clean', tailmix: false, musicMix: true, tailSeconds: 5 } }, resolve, path.join(dir, 'clean-audio-only'));
  assert.ok(Math.abs(cleanAudioOnly[0].duration - 0.5) < 0.15, 'Clean3 audio-only does not append tailSeconds');
  const cleanAudioInspected = await Verification.inspect(engine, path.join(dir, 'clean-audio-only', cleanAudioOnly[0].name));
  assert.equal(cleanAudioInspected.audio?.audible, true, 'Clean3 audio-only mixes audible track without tails');
  const uniqueAudioOnly = await engine.process({ inputs: ['2'], tails: [], music: [{ id: '0', volume: 80 }], tailMusic: [], edits: {}, settings: { ...base, mode: 'unique', musicMix: true } }, resolve, path.join(dir, 'unique-audio-only'));
  assert.ok(Math.abs(uniqueAudioOnly[0].duration - 0.5) < 0.15, 'Unique audio-only keeps video duration');
  const uniqueAudioInspected = await Verification.inspect(engine, path.join(dir, 'unique-audio-only', uniqueAudioOnly[0].name));
  assert.equal(uniqueAudioInspected.audio?.audible, true, 'Unique audio-only mixes audible track onto silent source');
  const identical = path.join(dir, 'identical.mp4');
  await fs.copyFile(source, identical);
  const unchanged = await Verification.verify(engine, source, identical, {}, null);
  assert.equal(unchanged.status, 'warning');
  assert.equal(unchanged.checks.find(item => item.id === 'sha256').state, 'same');
  assert.equal(unchanged.checks.find(item => item.id === 'video').state, 'same');
  const silentCopy = path.join(dir, 'silent-copy.mp4');
  await fs.copyFile(silent, silentCopy);
  const silentReport = await Verification.verify(engine, silent, silentCopy, {}, null);
  assert.equal(silentReport.checks.find(item => item.id === 'spectrum').state, 'na');
  assert.equal(silentReport.checks.find(item => item.id === 'composition').state, 'unavailable');
  const controller = new AbortController();
  let kept;
  await assert.rejects(engine.process({ ...request, settings: { ...base, mode: 'unique' } }, resolve, path.join(dir, 'cancel'), {
    signal: controller.signal,
    onUpdate(update) {
      if (update.label.startsWith('Проверка изменений')) { kept = update.outputs[0]; controller.abort(); }
    }
  }), /остановлена/);
  assert.ok(kept);
  assert.ok((await fs.stat(path.join(dir, 'cancel', kept.name))).size > 0);
  assert.equal(kept.verification.status, 'unavailable');
  assert.equal(await fs.stat(path.join(dir, 'cancel', 'work')).catch(() => null), null);
  console.log('verification fixture folder', dir);
});

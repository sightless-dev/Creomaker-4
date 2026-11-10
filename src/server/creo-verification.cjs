'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const VERSION = 1;
const SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const BANDS = [0, 125, 250, 500, 1000, 2000, 4000, 8000, 22051];
const FRACTIONS = [.1, .45, .78, .98];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const round = value => Number(value.toFixed(5));

function cancelled(signal) {
  if (signal?.aborted) throw Error('Проверка остановлена.');
}

async function fileHash(file, signal) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    cancelled(signal);
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function decode(engine, file, seek, args, signal) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(engine.ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1',
      '-filter_threads', '1', '-protocol_whitelist', 'file,pipe',
      '-ss', String(seek), '-i', file, ...args, 'pipe:1'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let error = '';
    let oversized = false;
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        oversized = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(Error('Проверка остановлена.'));
      if (oversized) return reject(Error('Превышен размер выборки проверки.'));
      if (code !== 0) return reject(Error('Не удалось декодировать выборку. ' + error.trim()));
      resolve(Buffer.concat(chunks));
    });
  });
}

function frameFeatures(bytes) {
  if (bytes.length !== 32 * 32 * 3) throw Error('Неполный кадр проверки.');
  const luma = new Float64Array(1024);
  const color = new Array(48).fill(0);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const i = y * 32 + x;
      const cell = (Math.floor(y / 8) * 4 + Math.floor(x / 8)) * 3;
      for (let channel = 0; channel < 3; channel++) color[cell + channel] += bytes[i * 3 + channel] / 64;
      luma[i] = bytes[i * 3] * .2126 + bytes[i * 3 + 1] * .7152 + bytes[i * 3 + 2] * .0722;
    }
  }
  const edges = new Array(64).fill(0);
  for (let y = 1; y < 32; y++) {
    for (let x = 1; x < 32; x++) {
      const i = y * 32 + x;
      edges[Math.floor(y / 4) * 8 + Math.floor(x / 4)] += Math.hypot(luma[i] - luma[i - 1], luma[i] - luma[i - 32]);
    }
  }
  const edgeSum = edges.reduce((a, b) => a + b, 0);
  return { color: color.map(round), edges: edges.map(v => edgeSum ? round(v / edgeSum) : 0), edgeSum: round(edgeSum) };
}

function fftPower(samples, offset, channel) {
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    const index = offset + i * 4 + channel * 2;
    const value = index + 2 <= samples.length ? samples.readInt16LE(index) / 32768 : 0;
    real[i] = value * (.5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  }
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let length = 2; length <= FFT_SIZE; length *= 2) {
    const angle = -2 * Math.PI / length;
    for (let start = 0; start < FFT_SIZE; start += length) {
      for (let i = 0; i < length / 2; i++) {
        const cosine = Math.cos(angle * i), sine = Math.sin(angle * i);
        const a = start + i, b = a + length / 2;
        const r = real[b] * cosine - imag[b] * sine;
        const n = real[b] * sine + imag[b] * cosine;
        real[b] = real[a] - r;
        imag[b] = imag[a] - n;
        real[a] += r;
        imag[a] += n;
      }
    }
  }
  return Array.from({ length: FFT_SIZE / 2 + 1 }, (_, i) => real[i] ** 2 + imag[i] ** 2);
}

function audioFeatures(chunks) {
  const power = new Array(FFT_SIZE / 2 + 1).fill(0);
  let square = 0, peak = 0, count = 0, windows = 0;
  for (const bytes of chunks) {
    for (let i = 0; i + 2 <= bytes.length; i += 2) {
      const sample = bytes.readInt16LE(i) / 32768;
      square += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      count++;
    }
    for (let offset = 0; offset + FFT_SIZE * 4 <= bytes.length; offset += FFT_SIZE * 2) {
      for (let channel = 0; channel < 2; channel++) {
        const window = fftPower(bytes, offset, channel);
        windows++;
        window.forEach((v, i) => { power[i] += v; });
      }
    }
  }
  const total = power.reduce((a, b) => a + b, 0);
  const bands = BANDS.slice(1).map(() => 0);
  let centroid = 0;
  power.forEach((value, i) => {
    const frequency = i * SAMPLE_RATE / FFT_SIZE;
    const band = BANDS.findIndex((limit, index) => index > 0 && frequency < limit) - 1;
    if (band >= 0) bands[band] += value;
    centroid += value * frequency;
  });
  const normalized = bands.map(v => total ? round(v / total) : 0);
  const rms = count ? Math.sqrt(square / count) : 0;
  return {
    audible: rms > .00003,
    windows,
    rmsDb: round(20 * Math.log10(Math.max(rms, 1e-9))),
    peakDb: round(20 * Math.log10(Math.max(peak, 1e-9))),
    centroidHz: total ? round(centroid / total) : 0,
    bands: normalized,
    fingerprint: hash(JSON.stringify({ bands: normalized.map(v => Math.round(v * 1000)), centroid: total ? Math.round(centroid / total / 2) : 0 })),
    decodedSha256: hash(Buffer.concat(chunks))
  };
}

function metadata(probe) {
  const technical = new Set(['encoder', 'major_brand', 'minor_version', 'compatible_brands']);
  return Object.fromEntries(Object.entries(probe.tags || {}).filter(([key]) => !technical.has(key)).sort(([a], [b]) => a.localeCompare(b)));
}

async function inspect(engine, file, signal) {
  cancelled(signal);
  const before = await fsp.stat(file);
  const probe = await engine.probe(file, signal);
  const frames = [];
  const audio = [];
  const times = [];
  for (const fraction of FRACTIONS) {
    const time = Math.max(0, Math.min(probe.duration * fraction, probe.duration - Math.min(.18, probe.duration / 3)));
    const pixels = await decode(engine, file, time, ['-an', '-frames:v', '1', '-vf', 'scale=32:32:flags=area', '-pix_fmt', 'rgb24', '-f', 'rawvideo'], signal);
    frames.push(frameFeatures(pixels));
    times.push(round(time));
    if (probe.audio) {
      const audioTime = Math.max(0, Math.min(time, probe.duration - .4));
      audio.push(await decode(engine, file, audioTime, ['-vn', '-t', '0.4', '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 's16le'], signal));
    }
  }
  const digest = await fileHash(file, signal);
  const after = await fsp.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('Файл изменился во время проверки. Повторите обработку.');
  const tags = metadata(probe);
  return {
    sha256: digest, bytes: before.size, duration: probe.duration, fps: probe.frameRate,
    width: probe.displayWidth || probe.width, height: probe.displayHeight || probe.height,
    metadataSha256: hash(JSON.stringify(tags)), metadataKeys: Object.keys(tags), tags,
    sampleTimes: times, frames,
    videoFingerprint: hash(JSON.stringify(frames.map(frame => frame.color.map(v => Math.round(v / 4))))),
    audio: probe.audio ? audioFeatures(audio) : null
  };
}

function compare(source, output, { requireSignals = true, requireAudio = requireSignals, metadataEnabled = true, mainDuration, tailSeconds = 0 } = {}) {
  const checks = [];
  const add = (id, label, state, message) => checks.push({ id, label, state, message });
  add('sha256', 'SHA-256 файла', source.sha256 !== output.sha256 ? 'changed' : 'same', source.sha256 !== output.sha256 ? 'Разные байты файла' : 'Файлы побайтно совпадают');
  const keys = [...new Set([...source.metadataKeys, ...output.metadataKeys])].filter(k => source.tags[k] !== output.tags[k]);
  add('metadata', 'Метаданные', !metadataEnabled ? 'na' : keys.length ? 'changed' : 'same', !metadataEnabled ? 'Перезапись выключена' : keys.length ? 'Изменены поля ' + keys.join(', ') : 'Описательные теги совпадают');
  let colorDistance = 0, edgeDistance = 0;
  for (let i = 0; i < source.frames.length; i++) {
    const a = source.frames[i], b = output.frames[i];
    colorDistance += a.color.reduce((sum, v, j) => sum + Math.abs(v - b.color[j]), 0) / a.color.length / source.frames.length;
    edgeDistance += a.edges.reduce((sum, v, j) => sum + Math.abs(v - b.edges[j]), 0) / source.frames.length;
  }
  const visualChanged = colorDistance >= 2;
  add('video', 'Видеоотпечаток', visualChanged ? 'changed' : 'same', 'Разница цветовых блоков ' + round(colorDistance) + ' / 255');
  const spatiallyReadable = source.frames.some(f => f.edgeSum > 1) && output.frames.some(f => f.edgeSum > 1);
  const aspectChanged = Math.abs(source.width / source.height - output.width / output.height) > .01;
  add('composition', 'Композиция кадра', !requireSignals ? 'na' : aspectChanged || edgeDistance >= .035 ? 'changed' : !spatiallyReadable ? 'unavailable' : 'same', !requireSignals ? 'Преобразование не запрошено' : aspectChanged ? 'Изменены пропорции кадра' : !spatiallyReadable ? 'Однородные кадры — недостаточно деталей' : 'Разница пространственных границ ' + round(edgeDistance));
  const knownFps = Number.isFinite(source.fps) && source.fps > 0 && Number.isFinite(output.fps) && output.fps > 0;
  add('fps', 'Частота кадров', !requireSignals ? 'na' : !knownFps ? 'unavailable' : Math.abs(source.fps - output.fps) > .05 ? 'changed' : 'same', knownFps ? round(source.fps) + ' → ' + round(output.fps) + ' кадр/с' : 'Недостаточно данных о частоте кадров');
  const a = source.audio, b = output.audio;
  if (!requireAudio || !a?.audible && !b?.audible) {
    for (const [id, label] of [['audio', 'Аудиоотпечаток'], ['spectrum', 'Спектр звука'], ['amplitude', 'Амплитуда звука']]) add(id, label, 'na', !requireAudio ? 'Преобразование не запрошено' : 'Нет слышимого звука для сравнения');
  } else if (!a?.audible || !b?.audible) {
    add('audio', 'Аудиоотпечаток', b?.audible ? 'changed' : 'unavailable', b?.audible ? 'Добавлен слышимый звук' : 'Звук исходника отсутствует в результате');
    add('spectrum', 'Спектр звука', 'na', 'Только одна сторона содержит слышимый звук');
    add('amplitude', 'Амплитуда звука', 'na', 'Только одна сторона содержит слышимый звук');
  } else {
    const spectrum = a.bands.reduce((sum, v, i) => sum + Math.abs(v - b.bands[i]), 0);
    const centroid = Math.abs(a.centroidHz - b.centroidHz) / Math.max(1, a.centroidHz);
    const sufficient = a.windows > 0 && b.windows > 0;
    add('audio', 'Аудиоотпечаток', !sufficient ? 'unavailable' : a.fingerprint !== b.fingerprint ? 'changed' : 'same', sufficient ? 'Отпечаток полос и спектрального центра' : 'Фрагмент слишком короткий для спектрального анализа');
    add('spectrum', 'Спектр звука', !sufficient ? 'unavailable' : spectrum >= .01 || centroid >= .01 ? 'changed' : 'same', sufficient ? round(a.centroidHz) + ' → ' + round(b.centroidHz) + ' Гц · разница полос ' + round(spectrum) : 'Фрагмент слишком короткий для спектрального анализа');
    add('amplitude', 'Амплитуда звука', Math.max(Math.abs(a.rmsDb - b.rmsDb), Math.abs(a.peakDb - b.peakDb)) >= .25 ? 'changed' : 'same', 'RMS ' + a.rmsDb + ' → ' + b.rmsDb + ' dBFS · пик ' + a.peakDb + ' → ' + b.peakDb + ' dBFS');
  }
  if (tailSeconds) {
    const observed = output.duration - mainDuration;
    const matches = Math.abs(observed - tailSeconds) <= Math.max(.12, 2 / (output.fps || 30));
    add('tails', 'Длительность хвостов', matches ? 'changed' : 'same', 'Ожидалось ' + tailSeconds + ' с · измерено ' + round(observed) + ' с');
  }
  const warnings = checks.filter(c => c.state === 'same' || c.state === 'unavailable').length;
  return { status: warnings ? 'warning' : 'verified', checks, warnings, changed: checks.filter(c => c.state === 'changed').length };
}

async function verify(engine, sourceFile, outputFile, options, baseline, signal) {
  const source = baseline || await inspect(engine, sourceFile, signal);
  const output = await inspect(engine, outputFile, signal);
  const result = compare(source, output, options);
  const publicMetrics = value => {
    const { tags, ...metrics } = value;
    return metrics;
  };
  const report = {
    version: VERSION, createdAt: new Date().toISOString(), method: 'creomaker-sampled-v1',
    scope: 'SHA-256 всего файла; четыре декодированных кадра и четыре фрагмента звука по 0,4 с. Выборочный анализ.',
    analysis: { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, window: 'Hann', channels: 2, spectralBandEdgesHz: BANDS },
    thresholds: { videoColor: 2, compositionEdges: .035, amplitudeDb: .25, spectralBands: .01, centroidRatio: .01 },
    ...result, source: publicMetrics(source), output: publicMetrics(output)
  };
  const name = options.reportDir && path.basename(outputFile) + '.verification.json';
  if(name){
    await fsp.mkdir(options.reportDir,{recursive:true});
    const file=path.join(options.reportDir,name);
    await fsp.writeFile(file+'.tmp',JSON.stringify(report,null,2));
    await fsp.rename(file+'.tmp',file);
  }
  return { ...result, version: VERSION, report: name, sourceSha256: source.sha256, outputSha256: output.sha256 };
}

module.exports = { inspect, compare, verify, audioFeatures, frameFeatures };

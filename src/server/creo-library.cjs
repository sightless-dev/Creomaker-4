'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { audioExts, videoExts } = require('./creo-engine.cjs');

async function entries(folder) {
  try { return await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function bundledLibrary(root) {
  const groups = [['music', 'music', audioExts], ['Tails', 'tails', videoExts], ['tail_music', 'tailMusic', audioExts]];
  const directories = (await entries(root)).filter(entry => entry.isDirectory());
  const media = new Map();
  async function walk(folder, kind, extensions, source) {
    const children = (await entries(folder)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file, kind, extensions, source);
      if (!entry.isFile() || !extensions.includes(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.lstat(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!stat?.isFile()) continue;
      const key = kind + ':' + entry.name.toLowerCase() + ':' + stat.size;
      const id = 'bundled-' + createHash('sha256').update(key).digest('hex').slice(0, 24);
      if (!media.has(id)) media.set(id, { id, name: entry.name, path: file, kind, size: stat.size, builtin: true, source });
    }
  }
  for (const [name, kind, extensions] of groups) {
    const directory = directories.find(entry => entry.name === name)
      || directories.find(entry => entry.name.toLowerCase() === name.toLowerCase());
    if (directory) await walk(path.join(root, directory.name), kind, extensions, 'assets/' + directory.name);
  }
  return media;
}

module.exports = { bundledLibrary };

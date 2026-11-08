'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const assetsManager = require('../src/server/creo-assets-manager.cjs');

test('assets manager: status detection and counting', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'creo-assets-test-'));
  try {
    const s1 = await assetsManager.getStatus(tmpDir);
    assert.equal(s1.installed, false);
    assert.equal(s1.count, 0);
    assert.equal(s1.downloading, false);

    // Create some fake tails
    const tailsDir = path.join(tmpDir, 'Tails');
    await fsp.mkdir(tailsDir, { recursive: true });
    for (let i = 1; i <= 6; i++) {
      await fsp.writeFile(path.join(tailsDir, `tail_${i}.mp4`), 'fake video data');
    }

    const s2 = await assetsManager.getStatus(tmpDir);
    assert.equal(s2.installed, true);
    assert.equal(s2.count, 6);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('assets manager: store-zip extraction works with crc32 verification', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'creo-zip-test-'));
  try {
    // Helper to build a minimal valid ZIP archive with method 0 (Store)
    function buildStoreZip(entries) {
      const parts = [];
      const cdParts = [];
      let offset = 0;

      for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const crc = (zlib.crc32(dataBuf) >>> 0);
        const compSize = dataBuf.length;
        const uncompSize = dataBuf.length;

        // Local file header (30 bytes + nameLen)
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0); // signature
        lfh.writeUInt16LE(20, 4);         // version needed
        lfh.writeUInt16LE(0, 6);          // flags
        lfh.writeUInt16LE(0, 8);          // method 0 = store
        lfh.writeUInt16LE(0, 10);         // time
        lfh.writeUInt16LE(0, 12);         // date
        lfh.writeUInt32LE(crc, 14);       // crc32
        lfh.writeUInt32LE(compSize, 18);   // comp size
        lfh.writeUInt32LE(uncompSize, 22); // uncomp size
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);         // extra len

        parts.push(lfh, nameBuf, dataBuf);

        // Central directory entry (46 bytes + nameLen)
        const cdh = Buffer.alloc(46);
        cdh.writeUInt32LE(0x02014b50, 0); // signature
        cdh.writeUInt16LE(20, 4);         // version made by
        cdh.writeUInt16LE(20, 6);         // version needed
        cdh.writeUInt16LE(0, 8);          // flags
        cdh.writeUInt16LE(0, 10);         // method 0
        cdh.writeUInt16LE(0, 12);         // time
        cdh.writeUInt16LE(0, 14);         // date
        cdh.writeUInt32LE(crc, 16);       // crc32
        cdh.writeUInt32LE(compSize, 20);  // comp size
        cdh.writeUInt32LE(uncompSize, 24); // uncomp size
        cdh.writeUInt16LE(nameBuf.length, 28);
        cdh.writeUInt16LE(0, 30);         // extra len
        cdh.writeUInt16LE(0, 32);         // comment len
        cdh.writeUInt16LE(0, 34);         // disk number
        cdh.writeUInt16LE(0, 36);         // internal attrs
        cdh.writeUInt32LE(0, 38);         // external attrs
        cdh.writeUInt32LE(offset, 42);    // local header offset

        cdParts.push(cdh, nameBuf);

        offset += lfh.length + nameBuf.length + dataBuf.length;
      }

      const cdBuffer = Buffer.concat(cdParts);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); // signature
      eocd.writeUInt16LE(0, 4);          // disk num
      eocd.writeUInt16LE(0, 6);          // start disk
      eocd.writeUInt16LE(entries.length, 8);  // entries on disk
      eocd.writeUInt16LE(entries.length, 10); // total entries
      eocd.writeUInt32LE(cdBuffer.length, 12); // cd size
      eocd.writeUInt32LE(offset, 16);    // cd offset
      eocd.writeUInt16LE(0, 20);         // comment len

      return Buffer.concat([...parts, cdBuffer, eocd]);
    }

    const testZip = path.join(tmpDir, 'test.zip');
    const zipData = buildStoreZip([
      { name: 'assets/Tails/t1.mp4', data: 'hello tail 1' },
      { name: 'assets/music/m1.mp3', data: 'hello music 1' }
    ]);
    await fsp.writeFile(testZip, zipData);

    const outDir = path.join(tmpDir, 'extracted');
    const extractedEntries = [];
    assetsManager.extractZipFile(testZip, outDir, (cur, total, name) => {
      extractedEntries.push({ cur, total, name });
    });

    assert.equal(extractedEntries.length, 2);
    assert.equal(fs.readFileSync(path.join(outDir, 'Tails', 't1.mp4'), 'utf8'), 'hello tail 1');
    assert.equal(fs.readFileSync(path.join(outDir, 'music', 'm1.mp3'), 'utf8'), 'hello music 1');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

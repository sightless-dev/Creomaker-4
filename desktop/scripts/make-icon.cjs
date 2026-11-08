'use strict';
/*
 * Generates build-res/icon.png (1024×1024 RGBA PNG) in pure Node.js with 4× supersampled
 * signed-distance-field rendering: macOS-squircle rounded icon with red gradient, top gloss,
 * and the white CreoMaker "C" + play triangle emblem.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// Signed distance to rounded box centered at (512, 512), half-size 412, corner radius 190
function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance to a C-arc centered at (cx, cy), radius R, half-thickness th, opening angle ±openRad on the right
function sdCArc(px, py, cx, cy, R, th, openRad) {
  const dx = px - cx;
  const dy = py - cy;
  const ang = Math.atan2(Math.abs(dy), dx); // 0 is right (+x), pi is left (-x)
  if (ang > openRad) {
    return Math.abs(Math.hypot(dx, dy) - R) - th;
  }
  // Distance to the two cap centers at angle = ±openRad
  const capX = cx + R * Math.cos(openRad);
  const capY = R * Math.sin(openRad);
  const d1 = Math.hypot(px - capX, Math.abs(py - cy) - capY);
  return d1 - th;
}

// Signed distance to triangle (ax,ay)-(bx,by)-(cx,cy)
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;
  const c0 = clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y), 0, 1);
  const c1 = clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y), 0, 1);
  const c2 = clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y), 0, 1);
  const d0x = v0x - e0x * c0, d0y = v0y - e0y * c0;
  const d1x = v1x - e1x * c1, d1y = v1y - e1y * c1;
  const d2x = v2x - e2x * c2, d2y = v2y - e2y * c2;
  const minD2 = Math.min(d0x * d0x + d0y * d0y, d1x * d1x + d1y * d1y, d2x * d2x + d2y * d2y);
  const s = e0x * e2y - e0y * e2x;
  const s0 = s * (v0x * e0y - v0y * e0x);
  const s1 = s * (v1x * e1y - v1y * e1x);
  const s2 = s * (v2x * e2y - v2y * e2x);
  const sign = Math.min(s0, s1, s2) < 0 ? 1 : -1;
  return Math.sqrt(minD2) * sign;
}

const openRad = (48 * Math.PI) / 180;

for (let y = 0; y < SIZE; y++) {
  const rowOff = y * (1 + SIZE * 4);
  raw[rowOff] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    const dBox = sdRoundBox(px, py, 512, 512, 412, 412, 190);
    const boxAlpha = 1 - smoothstep(-0.8, 0.8, dBox);
    if (boxAlpha <= 0) continue;

    // Diagonal red gradient (#ff5a68 -> #b8202f)
    const gt = clamp(((px - 100) + (py - 100)) / (824 * 2), 0, 1);
    let r = 255 + (184 - 255) * gt;
    let g = 90 + (32 - 90) * gt;
    let b = 104 + (47 - 104) * gt;

    // Top subtle gloss
    if (py < 540) {
      const gloss = Math.pow(clamp(1 - (py - 100) / 440, 0, 1), 1.8) * 0.22;
      r = r + (255 - r) * gloss;
      g = g + (255 - g) * gloss;
      b = b + (255 - b) * gloss;
    }

    // Inner subtle border highlight
    const borderBand = Math.exp(-Math.pow((dBox + 3.5) / 2.2, 2)) * 0.16;
    r = r + (255 - r) * borderBand;
    g = g + (255 - g) * borderBand;
    b = b + (255 - b) * borderBand;

    // White emblem: "C" arc + rounded play triangle inside
    const dArc = sdCArc(px, py, 488, 512, 210, 48, openRad);
    const dTri = sdTriangle(px, py, 595, 442, 725, 512, 595, 582) - 10;
    const dGlyph = Math.min(dArc, dTri);

    // Subtle drop shadow under glyph
    const dArcShadow = sdCArc(px, py - 10, 488, 512, 210, 48, openRad);
    const dTriShadow = sdTriangle(px, py - 10, 595, 442, 725, 512, 595, 582) - 10;
    const dShadow = Math.min(dArcShadow, dTriShadow);
    const shadowAlpha = (1 - smoothstep(-6, 14, dShadow)) * 0.22;
    r *= 1 - shadowAlpha;
    g *= 1 - shadowAlpha;
    b *= 1 - shadowAlpha;

    const glyphAlpha = 1 - smoothstep(-0.85, 0.85, dGlyph);
    r = r + (255 - r) * glyphAlpha;
    g = g + (255 - g) * glyphAlpha;
    b = b + (255 - b) * glyphAlpha;

    const off = rowOff + 1 + x * 4;
    raw[off] = Math.round(clamp(r, 0, 255));
    raw[off + 1] = Math.round(clamp(g, 0, 255));
    raw[off + 2] = Math.round(clamp(b, 0, 255));
    raw[off + 3] = Math.round(clamp(boxAlpha * 255, 0, 255));
  }
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 8-bit
ihdr[9] = 6; // RGBA
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', idat),
  pngChunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'build-res', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('Generated icon.png:', out, png.length, 'bytes');

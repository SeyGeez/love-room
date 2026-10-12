'use strict';
// Génère client/assets/icon.png (cœur rose, 512x512) sans dépendance. Usage : node scripts/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const SS = 3; // sur-échantillonnage pour lisser les bords

function inHeart(px, py) {
  const x = ((px / SIZE) * 2 - 1) * 1.25;
  const y = -((py / SIZE) * 2 - 1.05) * 1.25;
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) if (inHeart(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    const t = y / SIZE;
    raw[o] = 255;
    raw[o + 1] = Math.round(70 + 40 * t);
    raw[o + 2] = Math.round(120 + 30 * t);
    raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '../client/assets/icon.png');
fs.writeFileSync(out, png);
console.log('écrit', out, png.length, 'octets');

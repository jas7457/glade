#!/usr/bin/env node
// Regenerates pairing-qr.png (the fixture of pairing-qr.test.ts): the QR code the Mac's Share This
// Device… dialog draws for PAIRING_QR_LINK (packages/app-core/src/ui/QrCode.tsx: uqr, ECC M, 4-module quiet
// zone), as an 8-bit grayscale PNG with 4 px per module.
//
//   node apps/iphone/src/lib/fixtures/make-pairing-qr.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { encode } from "uqr";

export const PAIRING_QR_LINK =
  "glade://pair?v=1&e=env_01J8ZQ4W6K2M3N5P7R9S1T3V5X&n=Jason%27s+MacBook+Pro&u=http%3A%2F%2F192.168.1.20%3A4317&u=https%3A%2F%2Fjasons-mbp.tail1a2b3.ts.net&u=http%3A%2F%2F127.0.0.1%3A4317&g=Qm9vdHN0cmFwR3JhbnQxMjM0NQ";
const QUIET = 4;
const SCALE = 4;

const { data, size } = encode(PAIRING_QR_LINK, { ecc: "M", border: 0 });
const side = (size + QUIET * 2) * SCALE;
const raw = Buffer.alloc(side * (side + 1));
for (let y = 0; y < side; y++) {
  raw[y * (side + 1)] = 0; // filter: none
  for (let x = 0; x < side; x++) {
    const mx = Math.floor(x / SCALE) - QUIET;
    const my = Math.floor(y / SCALE) - QUIET;
    const dark = mx >= 0 && my >= 0 && mx < size && my < size && data[my][mx];
    raw[y * (side + 1) + 1 + x] = dark ? 0 : 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(side, 0);
ihdr.writeUInt32BE(side, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // grayscale
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = new URL("./pairing-qr.png", import.meta.url);
writeFileSync(out, png);
console.log(`${out.pathname}: ${size}×${size} modules, ${side}px, ${png.length} bytes`);

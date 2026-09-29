/**
 * A generated PNG for the fake harness's `screenshot` prompt (I-157): a tool result with an image,
 * so image storage and rendering can be tried without an LLM. `seed` varies the colours (each
 * prompt gets a different image; the same seed gives the same bytes).
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let r = 0xffffffff;
  for (const b of bytes) r = CRC_TABLE[(r ^ b) & 255]! ^ (r >>> 8);
  return (r ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A `width`×`height` RGB PNG: a gradient with a card in the middle. */
export function fakePng(seed = 0, width = 320, height = 200): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  const hue = (seed * 67) % 200;
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * row + 1 + x * 3;
      const card = x > width * 0.15 && x < width * 0.85 && y > height * 0.2 && y < height * 0.8;
      raw[o] = card ? 250 : (40 + hue + (x * 100) / width) & 255;
      raw[o + 1] = card ? 250 : 60 + Math.round((y * 120) / height);
      raw[o + 2] = card ? 252 : 180;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Glade's own ids for stored rows (I-121): ULIDs (26 characters, Crockford base32: 48-bit time +
 * 80 bits of randomness). They sort by creation time, so message ids assigned while streaming
 * and ids assigned on import both order naturally. Monotonic within one process: several ids in
 * the same millisecond still sort in the order they were made.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = "";
  let t = Math.max(0, Math.floor(time));
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from({ length: 16 }, (_, i) => bytes[i]! % 32);
}

/** Increment a base32 digit array (carry to the left); wraps only after 2^80 ids in one ms. */
function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]!++;
      return next;
    }
    next[i] = 0;
  }
  return next;
}

/** A new ULID. `time` (epoch ms) defaults to now; imported messages pass their own timestamp. */
export function ulid(time: number = Date.now()): string {
  let random: number[];
  if (time === lastTime) random = increment(lastRandom);
  else random = freshRandom();
  if (time >= lastTime) {
    lastTime = time;
    lastRandom = random;
  }
  return encodeTime(time) + random.map((d) => ALPHABET[d]).join("");
}

export function isUlid(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

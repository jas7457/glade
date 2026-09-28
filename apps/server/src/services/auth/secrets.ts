/**
 * Secrets for device auth and pairing (I-125/I-126): device tokens (256-bit), pairing grants
 * (128-bit), WebSocket tickets, short pairing codes (8 characters of Crockford base32, shown as
 * `ABCD-EFGH`) and their SHA-256 hashes (only hashes are stored).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Crockford base32: no I, L, O, U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison (equal lengths only). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A new short code, 8 characters, grouped `ABCD-EFGH`. */
export function newPairingCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i]! & 31];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * The canonical form of something typed as a code (`abcd efgh`, `ABCD-EFGH`, `abcdefgh`), with
 * Crockford's lookalikes folded (I/L → 1, O → 0); `null` when it isn't an 8-character code.
 */
export function normalizePairingCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== 8) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

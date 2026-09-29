/** I-143: the code-free pairing number (both sides derive it the same way) and its SHA-256. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pairingNumber } from "./auth.js";
import { sha256Hex } from "./sha256.js";

describe("sha256Hex", () => {
  it("matches Node's SHA-256 (standard vectors, multi-block, UTF-8)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const text of ["a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "héllo ✓ 𝄞"]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("pairingNumber", () => {
  it("is 4 zero-padded digits of SHA-256(client:host) mod 10000, and depends on both nonces", () => {
    const n = pairingNumber("client-nonce-0123456789", "hostNonce_abcdefghij");
    expect(n).toMatch(/^\d{4}$/);
    const digest = createHash("sha256").update("client-nonce-0123456789:hostNonce_abcdefghij").digest();
    expect(n).toBe(String(digest.readUIntBE(0, 6) % 10000).padStart(4, "0"));
    expect(pairingNumber("client-nonce-0123456789", "hostNonce_abcdefghij")).toBe(n);
    const others = new Set(Array.from({ length: 20 }, (_, i) => pairingNumber("client-nonce-0123456789", `host-${i}-nonce-xxxxxx`)));
    expect(others.size).toBeGreaterThan(10);
  });
});

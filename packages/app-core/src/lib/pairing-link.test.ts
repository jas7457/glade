import { describe, expect, it } from "vitest";
import type { PairingLink } from "@glade/protocol";
import { formatPairingLink, normalizeAddress, normalizeShortCode, parsePairInput, parsePairingLink } from "./pairing-link";

const link: PairingLink = {
  version: 1,
  environmentId: "01JENVAAAA",
  name: "Jason's Mac Studio & Co",
  urls: ["http://192.168.1.20:4327", "https://studio.tail1234.ts.net"],
  grant: "g_abc-DEF_123",
};

describe("pairing links", () => {
  it("round-trips format → parse (names and urls are encoded)", () => {
    const text = formatPairingLink(link);
    expect(text.startsWith("glade://pair?v=1&e=01JENVAAAA&n=")).toBe(true);
    expect(text).not.toContain(" ");
    expect(parsePairingLink(text)).toEqual(link);
  });

  it("finds a link inside pasted text and in wrapped forms", () => {
    const text = formatPairingLink(link);
    expect(parsePairingLink(`Pair with this: ${text}\n`)).toEqual(link);
    expect(parsePairingLink(`http://127.0.0.1:5317/pair?link=${encodeURIComponent(text)}`)).toEqual(link);
    // Design §3.5 form: the page's origin is the address.
    expect(parsePairingLink("https://studio.tail1234.ts.net/pair#g=GRANT&e=ENV")).toEqual({
      version: 1,
      environmentId: "ENV",
      name: "",
      urls: ["https://studio.tail1234.ts.net"],
      grant: "GRANT",
    });
  });

  it("rejects bad links", () => {
    expect(parsePairingLink("")).toBeNull();
    expect(parsePairingLink("hello")).toBeNull();
    expect(parsePairingLink("glade://pair?v=1&e=E&u=http://h:1")).toBeNull(); // no grant
    expect(parsePairingLink("glade://pair?v=1&g=G&u=http://h:1")).toBeNull(); // no env
    expect(parsePairingLink("glade://pair?v=1&e=E&g=G")).toBeNull(); // no url
    expect(parsePairingLink("glade://pair?v=1&e=E&g=G&u=javascript:alert(1)")).toBeNull(); // not http(s)
    expect(parsePairingLink("glade://pair?v=2&e=E&g=G&u=http://h:1")).toBeNull(); // unknown version
    expect(parsePairingLink("glade://other?v=1&e=E&g=G&u=http://h:1")).toBeNull();
    expect(parsePairingLink("https://example.com/login?g=G&e=E")).toBeNull();
  });
});

describe("short codes", () => {
  it("normalizes case, dashes, spaces and ambiguous letters", () => {
    expect(normalizeShortCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizeShortCode(" ab cd ef gh ")).toBe("ABCD-EFGH");
    expect(normalizeShortCode("ABCDEFGH")).toBe("ABCD-EFGH");
    // I and L read as 1, O as 0 (Crockford).
    expect(normalizeShortCode("iLoo-1234")).toBe("1100-1234");
  });
  it("rejects wrong lengths and letters outside the alphabet", () => {
    expect(normalizeShortCode("ABC-DEF")).toBeNull();
    expect(normalizeShortCode("ABCD-EFGHJ")).toBeNull();
    expect(normalizeShortCode("ABCD-EFGU")).toBeNull(); // U isn't used
    expect(normalizeShortCode("ABCD-EFG!")).toBeNull();
  });
});

describe("parsePairInput", () => {
  it("takes a link, or an address + code", () => {
    expect(parsePairInput(formatPairingLink(link))).toEqual({
      ok: true,
      target: { environmentId: link.environmentId, name: link.name, urls: link.urls, grant: link.grant },
    });
    expect(parsePairInput("abcd efgh", "192.168.1.20:4327")).toEqual({
      ok: true,
      target: { environmentId: null, name: null, urls: ["http://192.168.1.20:4327"], grant: "ABCD-EFGH" },
    });
  });
  it("explains what's missing", () => {
    expect(parsePairInput("glade://pair?v=1").ok).toBe(false);
    expect(parsePairInput("nope", "h:1")).toMatchObject({ ok: false, error: expect.stringMatching(/8-character code/) });
    expect(parsePairInput("ABCD-EFGH", "")).toMatchObject({ ok: false, error: expect.stringMatching(/address/) });
  });
  it("normalizes addresses", () => {
    expect(normalizeAddress("mac.tail1.ts.net")).toBe("https://mac.tail1.ts.net");
    expect(normalizeAddress("http://10.0.0.2:4327/")).toBe("http://10.0.0.2:4327");
    expect(normalizeAddress("not an address")).toBeNull();
  });
});

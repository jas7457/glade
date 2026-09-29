/**
 * What the iPhone does with a scanned pairing QR code (I-164 step 6), through the app's own path:
 * `startPairing` (state/connect.ts → parsePairInput + the HTTPS-only rule). The network part
 * (`runPairing`) is mocked: these tests are about which target a scanned text becomes.
 *
 * The Mac's Share This Device… QR encodes the invite's link verbatim (AddDeviceDialog →
 * `<QrCode value={invite.link}>`), and the server builds that link as
 * `glade://pair?v=1&e=<envId>&n=<name>&u=<url>…&g=<grant>` (auth-service.ts `pairingLink`).
 * The last test decodes a fixed QR image of such a link (fixtures/pairing-qr.png, made by
 * fixtures/make-pairing-qr.mjs the way ui/QrCode.tsx draws it) with a real decoder (jsQR).
 */
import jsQR from "jsqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairTarget } from "@glade/app-core/lib/pairing-link";
import { qrPath } from "@glade/app-core/ui/QrCode";
import { runPairing } from "@glade/app-core/state/pairing";
import { cancelPairing, pairState, startPairing } from "~/state/connect";
import { HTTPS_ONLY_MESSAGE } from "~/lib/address-policy";
import pairingQrPng from "./fixtures/pairing-qr.png?inline";

vi.mock("@glade/app-core/state/pairing", () => ({ runPairing: vi.fn(async () => ({ step: "cancelled" })) }));
vi.mock("~/lib/secrets", () => ({ deviceId: async () => "iphone-test" }));

const runPairingMock = vi.mocked(runPairing);

/** What pairing a scanned text starts: the target handed to runPairing, or the error shown. */
async function scanned(text: string): Promise<{ target: PairTarget } | { error: string }> {
  runPairingMock.mockClear();
  const state = await startPairing(text);
  if (state.step === "error") {
    expect(runPairingMock).not.toHaveBeenCalled();
    return { error: state.message };
  }
  expect(runPairingMock).toHaveBeenCalledOnce();
  const [target, options] = runPairingMock.mock.calls[0]!;
  expect(options).toMatchObject({ deviceKind: "phone", clientEnvironmentId: "iphone-test" });
  return { target };
}

beforeEach(() => runPairingMock.mockClear());
afterEach(() => {
  cancelPairing();
  pairState.value = null;
});

describe("a scanned pairing QR code", () => {
  it("glade:// link with an https address", async () => {
    expect(await scanned("glade://pair?v=1&e=env_1&n=Studio+Mac&u=https%3A%2F%2Fstudio.tail.ts.net&g=GRANT")).toEqual({
      target: { environmentId: "env_1", name: "Studio Mac", urls: ["https://studio.tail.ts.net"], grant: "GRANT" },
    });
  });

  it("https://<host>/pair#… link (the page's origin is the address)", async () => {
    expect(await scanned("https://studio.tail.ts.net/pair#g=GRANT&e=env_1&n=Studio")).toEqual({
      target: { environmentId: "env_1", name: "Studio", urls: ["https://studio.tail.ts.net"], grant: "GRANT" },
    });
  });

  it("several addresses: keeps https and loopback, in order, drops plain http on the LAN", async () => {
    const link =
      "glade://pair?v=1&e=env_1&n=Mac&u=http%3A%2F%2F192.168.1.20%3A4317&u=https%3A%2F%2Fmac.tail.ts.net&u=http%3A%2F%2F127.0.0.1%3A4317&g=G";
    expect(await scanned(link)).toEqual({
      target: { environmentId: "env_1", name: "Mac", urls: ["https://mac.tail.ts.net", "http://127.0.0.1:4317"], grant: "G" },
    });
  });

  it("refuses a Glade link with only plain-http LAN addresses", async () => {
    expect(await scanned("glade://pair?v=1&e=env_1&n=Mac&u=http%3A%2F%2F192.168.1.20%3A4317&u=http%3A%2F%2Fmac.local%3A4317&g=G")).toEqual({
      error: HTTPS_ONLY_MESSAGE,
    });
    // Same for a web link served over plain http.
    expect(await scanned("http://192.168.1.20:4317/pair#g=G&e=env_1")).toEqual({ error: HTTPS_ONLY_MESSAGE });
  });

  it("junk: another app's QR code, an incomplete link, empty text", async () => {
    expect(await scanned("https://example.com/menu")).toEqual({ error: expect.stringContaining("8-character code") });
    expect(await scanned("WIFI:S:Home;T:WPA;P:secret;;")).toEqual({ error: expect.stringContaining("Paste a pairing link") });
    expect(await scanned("glade://pair?v=1&e=env_1&u=https%3A%2F%2Fmac.tail.ts.net")).toEqual({
      error: expect.stringContaining("isn't complete"),
    });
    expect(await scanned("glade://pair?v=2&e=env_1&u=https%3A%2F%2Fmac.tail.ts.net&g=G")).toEqual({
      error: expect.stringContaining("isn't complete"),
    });
    expect(await scanned("")).toEqual({ error: expect.stringContaining("Paste a pairing link") });
  });
});

// -------------------------------------------------------------------------------------------------
// The fixed QR image
// -------------------------------------------------------------------------------------------------

/** Keep in sync with fixtures/make-pairing-qr.mjs. */
const PAIRING_QR_LINK =
  "glade://pair?v=1&e=env_01J8ZQ4W6K2M3N5P7R9S1T3V5X&n=Jason%27s+MacBook+Pro&u=http%3A%2F%2F192.168.1.20%3A4317&u=https%3A%2F%2Fjasons-mbp.tail1a2b3.ts.net&u=http%3A%2F%2F127.0.0.1%3A4317&g=Qm9vdHN0cmFwR3JhbnQxMjM0NQ";
const SCALE = 4;

/** Decodes the fixture: 8-bit grayscale, non-interlaced, every row filter 0 (what the script writes). */
async function readGrayPng(dataUrl: string): Promise<{ width: number; height: number; gray: Uint8Array }> {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([body[8], body[9], body[12]]).toEqual([8, 0, 0]);
    } else if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const compressed = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  idat.reduce((at, part) => (compressed.set(part, at), at + part.length), 0);
  const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0);
    gray.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, gray };
}

/** The modules the Mac draws (ui/QrCode.tsx's SVG path, quiet zone included) as rows of 0/1. */
function macModules(value: string): number[][] {
  const { path, size } = qrPath(value);
  const grid = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) grid[Number(y)]![Number(x) + i] = 1;
  }
  return grid;
}

describe("the Mac's pairing QR code (fixed image)", () => {
  it("is exactly what the Mac draws for the link", async () => {
    const { width, gray } = await readGrayPng(pairingQrPng);
    const expected = macModules(PAIRING_QR_LINK);
    expect(width).toBe(expected.length * SCALE);
    const fromImage = expected.map((row, y) => row.map((_, x) => (gray[(y * SCALE + 1) * width + x * SCALE + 1]! < 128 ? 1 : 0)));
    expect(fromImage).toEqual(expected);
  });

  it("decodes back to the link and pairs with its https + loopback addresses", async () => {
    const { width, height, gray } = await readGrayPng(pairingQrPng);
    const rgba = new Uint8ClampedArray(width * height * 4);
    gray.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
    const decoded = jsQR(rgba, width, height);
    expect(decoded?.data).toBe(PAIRING_QR_LINK);
    expect(await scanned(decoded!.data)).toEqual({
      target: {
        environmentId: "env_01J8ZQ4W6K2M3N5P7R9S1T3V5X",
        name: "Jason's MacBook Pro",
        urls: ["https://jasons-mbp.tail1a2b3.ts.net", "http://127.0.0.1:4317"],
        grant: "Qm9vdHN0cmFwR3JhbnQxMjM0NQ",
      },
    });
  });
});

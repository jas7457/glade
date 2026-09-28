/**
 * Pairing links and short codes (I-126, contract `PairingLink` in @glade/protocol auth.ts).
 *
 *   glade://pair?v=1&e=<envId>&n=<name>&u=<url>&u=<url>&g=<grant>
 *
 * The same link can arrive wrapped: as `…/pair?link=<glade link>` (deep links into the web UI,
 * the future phone app) or as `https://<host>/pair#g=…&e=…` (design §3.5: a phone camera opens
 * it in a browser; the URLs then default to that page's origin).
 *
 * A short code (`ABCD-EFGH`, Crockford base32) plus the host's address is the typed alternative.
 *
 * Portable client core (F-022): pure functions, no DOM.
 */
import type { PairingLink } from "@glade/protocol";

export const PAIRING_SCHEME = "glade:";

/** `glade://pair?…` for a link. `URLSearchParams` percent-encodes every value. */
export function formatPairingLink(link: PairingLink): string {
  const params = new URLSearchParams();
  params.set("v", String(link.version));
  params.set("e", link.environmentId);
  params.set("n", link.name);
  for (const url of link.urls) params.append("u", url);
  params.set("g", link.grant);
  return `glade://pair?${params.toString()}`;
}

/** Reads the fields of a link's parameters; `null` when anything required is missing or bad. */
function fromParams(params: URLSearchParams, fallbackUrls: string[] = []): PairingLink | null {
  const version = params.get("v") ?? "1";
  if (version !== "1") return null;
  const environmentId = params.get("e")?.trim();
  const grant = params.get("g")?.trim();
  if (!environmentId || !grant) return null;
  const urls = params.getAll("u").map((u) => u.trim()).filter(isHttpUrl);
  const all = urls.length > 0 ? urls : fallbackUrls;
  if (all.length === 0) return null;
  return { version: 1, environmentId, name: params.get("n")?.trim() || "", urls: all, grant };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse a pairing link (or text containing one, e.g. what a QR scanner hands over). Returns
 * `null` for anything that isn't a complete, supported link.
 */
export function parsePairingLink(text: string): PairingLink | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A link somewhere inside pasted text.
  const embedded = /glade:\/\/pair\?[^\s"'<>]+/i.exec(trimmed)?.[0];
  const candidate = embedded ?? trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol === PAIRING_SCHEME) {
    // `glade://pair?…`: the "host" is `pair`.
    if (url.host !== "pair" && !url.pathname.replace(/^\/+/, "").startsWith("pair")) return null;
    return fromParams(url.searchParams);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!/\/pair\/?$/.test(url.pathname)) return null;
  const wrapped = url.searchParams.get("link");
  if (wrapped) return parsePairingLink(wrapped);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  return fromParams(hash.has("g") ? hash : url.searchParams, [url.origin]);
}

// ---------------------------------------------------------------------------------------------
// Short codes
// ---------------------------------------------------------------------------------------------

/** Crockford base32: no I, L, O, U. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHORT_CODE_LENGTH = 8;

/**
 * Normalize a typed short code to `ABCD-EFGH`: case, spaces and dashes don't matter, and the
 * letters people confuse map like Crockford's decoding (I/L → 1, O → 0). `null` if it isn't
 * 8 valid characters.
 */
export function normalizeShortCode(input: string): string | null {
  const chars = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (chars.length !== SHORT_CODE_LENGTH) return null;
  for (const c of chars) if (!CODE_ALPHABET.includes(c)) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * A typed host address → its origin: `192.168.1.5:4327` → `http://192.168.1.5:4327`,
 * `mac.tail.ts.net` → `https://mac.tail.ts.net`. `null` if it isn't an address.
 */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // `.ts.net` names are served over HTTPS by `tailscale serve`; everything else defaults to HTTP.
  const withScheme = hasScheme ? trimmed : `${/\.ts\.net(:\d+)?$/i.test(trimmed) ? "https" : "http"}://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return null;
  }
}

/** What the user asked to pair with: from a link, or an address + short code. */
export interface PairTarget {
  /** The host's environment id, when known (links); checked against `GET /api/environment`. */
  environmentId: string | null;
  /** Host name for display, when known. */
  name: string | null;
  urls: string[];
  /** The link's grant or the normalized short code. */
  grant: string;
}

export type PairInputResult = { ok: true; target: PairTarget } | { ok: false; error: string };

/**
 * Turns the dialog's input into a target: a pasted link (or QR text) in `linkOrCode`, or an
 * address plus a code.
 */
export function parsePairInput(linkOrCode: string, address = ""): PairInputResult {
  const text = linkOrCode.trim();
  if (/glade:|\/pair\b/i.test(text)) {
    const link = parsePairingLink(text);
    if (!link) return { ok: false, error: "That pairing link isn't complete. Copy it again from the other Mac." };
    return { ok: true, target: { environmentId: link.environmentId, name: link.name || null, urls: link.urls, grant: link.grant } };
  }
  const code = normalizeShortCode(text);
  if (!code) return { ok: false, error: "Paste a pairing link, or enter the 8-character code (like ABCD-EFGH)." };
  const url = normalizeAddress(address);
  if (!url) return { ok: false, error: "Enter the other Mac's address (shown under the code)." };
  return { ok: true, target: { environmentId: null, name: null, urls: [url], grant: code } };
}

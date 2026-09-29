/**
 * Which Mac addresses the iPhone app may talk to (I-164, doc §4.3): **HTTPS only** (Tailscale
 * Serve's `https://<mac>.<tailnet>.ts.net`), except plain http to loopback, which on a real
 * iPhone is the phone itself (nothing listens there) and in the simulator is the Mac running a
 * `pnpm dev:agent` sandbox. iOS App Transport Security would let plain http to bare IP addresses
 * through, so the app checks it itself.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isAllowedAddress(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** The allowed ones, in order. */
export function allowedAddresses(urls: readonly string[]): string[] {
  return urls.filter(isAllowedAddress);
}

export const HTTPS_ONLY_MESSAGE =
  "Glade on iPhone only connects over HTTPS. Turn on remote access on the Mac (it uses Tailscale), then share it again.";

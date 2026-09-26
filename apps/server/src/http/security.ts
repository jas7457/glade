/**
 * Request gatekeeping for the HTTP API and WebSocket.
 *
 * Loopback mode (the only one implemented) protects a server bound to 127.0.0.1 against:
 * - DNS rebinding: the `Host` header must name a loopback host.
 * - Cross-site requests from web pages: mutating requests and WebSocket upgrades that carry an
 *   `Origin` must come from a loopback origin (any port, so the Vite dev server works).
 *
 * A future "remote" mode (token auth + configurable bind address) can be added as another
 * variant of {@link SecurityOptions} without touching the routes.
 */
import type { MiddlewareHandler } from "hono";

export type SecurityOptions = {
  mode: "loopback";
};
// Later: | { mode: "remote"; token: string; allowedHosts: string[] }

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Hostname of a `Host` header value (`127.0.0.1:4317` → `127.0.0.1`, `[::1]:80` → `[::1]`). */
export function hostHeaderHostname(host: string): string | null {
  try {
    const url = new URL(`http://${host}`);
    // Reject anything that isn't just host[:port] (e.g. "evil.com@localhost" or paths).
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/** True if `origin` is a loopback origin on any port/scheme. `null`/opaque origins are rejected. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function securityMiddleware(options: SecurityOptions = { mode: "loopback" }): MiddlewareHandler {
  if (options.mode !== "loopback") throw new Error(`Unsupported security mode: ${String(options.mode)}`);
  return async (c, next) => {
    // Node's server always sets Host; in-process requests (tests) fall back to the URL.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostHeaderHostname(host);
    if (!hostname || !isLoopbackHostname(hostname)) {
      return c.json({ error: "Forbidden host" }, 403);
    }

    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const isSafeMethod = c.req.method === "GET" || c.req.method === "HEAD";
    if (isUpgrade || !isSafeMethod) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        return c.json({ error: "Forbidden origin" }, 403);
      }
    }
    await next();
  };
}

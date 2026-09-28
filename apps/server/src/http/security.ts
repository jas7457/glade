/**
 * Request gatekeeping for the HTTP API and WebSocket.
 *
 * Loopback mode (the only one implemented) protects a server bound to 127.0.0.1 against:
 * - DNS rebinding: the `Host` header must name a loopback host.
 * - Cross-site requests from web pages: mutating requests and WebSocket upgrades that carry an
 *   `Origin` must come from a loopback origin (any port, so the Vite dev server works).
 *
 * Cross-origin reads between Glade servers (I-123, TEMPORARY): a web client served by one Glade
 * server (e.g. the app on :4327, or Vite on :5317) talks to other environments, which for now
 * means other Glade servers on this machine (multi-environment testing before auth exists).
 * So CORS is answered, preflight included, for **loopback http(s) origins on any port only**
 * (`http://127.0.0.1:*`, `http://localhost:*`, `http://[::1]:*`); any other origin gets no CORS
 * headers, and its preflights and mutating requests are refused. The WebSocket upgrade accepts a
 * loopback Origin from any port likewise. The bind address is unchanged (loopback), so nothing
 * off this machine can reach the server at all.
 * I-125 replaces this with device auth: paired devices' tokens, a Host allow-list, Origin checks
 * and CORS for paired origins only, and a local-app secret (loopback stops being trusted once
 * `tailscale serve` proxies to it). Until then, a page served from any loopback origin can read
 * the API's responses too (before I-123 it could only send requests blind); local processes
 * could always use it.
 *
 * A future "remote" mode (token auth + configurable bind address) can be added as another
 * variant of {@link SecurityOptions} without touching the routes.
 */
import type { Context, MiddlewareHandler } from "hono";

export type SecurityOptions = {
  mode: "loopback";
};
// Later: | { mode: "remote"; token: string; allowedHosts: string[] }

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Methods and headers a cross-origin loopback client may use (preflight answers). */
const CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "content-type, x-glade-command-id, authorization";
/** Response headers a cross-origin client may read (exports' file names). */
const CORS_EXPOSE = "content-disposition";
/** How long browsers may cache a preflight (s). */
const CORS_MAX_AGE = "600";

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

/**
 * Origins that get CORS answers (I-123, until I-125): loopback over http(s), any port, and
 * nothing but a scheme, host and port (an `Origin` never has a path).
 */
export function isCorsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || origin.endsWith("/")) return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function setCors(c: Context, origin: string): void {
  c.res.headers.set("Access-Control-Allow-Origin", origin);
  c.res.headers.set("Access-Control-Expose-Headers", CORS_EXPOSE);
  c.res.headers.append("Vary", "Origin");
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

    const origin = c.req.header("origin");
    const corsOrigin = origin !== undefined && isCorsOrigin(origin) ? origin : null;

    // CORS preflight: answered for loopback origins only, refused for everything else.
    if (c.req.method === "OPTIONS" && origin !== undefined && c.req.header("access-control-request-method")) {
      if (!corsOrigin) return c.json({ error: "Forbidden origin" }, 403);
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": CORS_METHODS,
          "Access-Control-Allow-Headers": CORS_HEADERS,
          "Access-Control-Max-Age": CORS_MAX_AGE,
          Vary: "Origin, Access-Control-Request-Headers",
        },
      });
    }

    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const isSafeMethod = c.req.method === "GET" || c.req.method === "HEAD";
    if (isUpgrade || !isSafeMethod) {
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        return c.json({ error: "Forbidden origin" }, 403);
      }
    }
    if (corsOrigin && !isUpgrade) setCors(c, corsOrigin);
    await next();
    // Responses made without the context (e.g. replayed command receipts) don't carry the
    // headers set above; add them now.
    if (corsOrigin && !isUpgrade && !c.res.headers.has("Access-Control-Allow-Origin")) {
      try {
        setCors(c, corsOrigin);
      } catch {
        /* immutable headers (a fetched response): nothing to add */
      }
    }
  };
}

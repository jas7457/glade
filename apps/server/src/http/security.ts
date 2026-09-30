/**
 * Request gatekeeping for the HTTP API and WebSocket (I-125; contract:
 * packages/protocol/src/auth.ts, design: docs/design/environments-and-store.md §3.5).
 *
 * Every request is either the **local owner** or a **remote client**:
 * - Local owner: the peer is loopback, the `Host` names a loopback host, there are no proxy
 *   headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-User-*`: `tailscale serve` adds them and a
 *   client can't remove them) and the `Origin`, if any, is the server's own: a loopback http(s)
 *   origin on the port the request came in on (the Vite dev proxy keeps the browser's `Host`), the
 *   server's listening port, or its web dev server's port (`GLADE_WEB_PORT`, 5317 for `pnpm dev`).
 *   In-process requests (tests: no socket) count as loopback peers.
 * - Everyone else is remote: refused with 403 `remote_disabled` unless the host turned remote
 *   access on, then needs a device token (`Authorization: Bearer`, or a one-time `?ticket=` on
 *   `/ws`), else 401 `unauthorized`. Without a token they may only `POST /api/auth/pair` (and `/pair/wait`, I-143),
 *   `GET /api/environment` (identity only) and load the web app's static files.
 *
 * `Host` allow-list (DNS rebinding): loopback plus the hostnames of the host's addresses
 * (RemoteAccessState.addresses); anything else is 403.
 *
 * CORS: never with cookies (we have none). Preflights are answered for any origin (they carry no
 * credentials and reveal nothing but the allowed methods and headers). Actual responses get
 * `Access-Control-Allow-Origin` (the request's origin) when the request is the local owner, a
 * remote client with a valid token, `POST /api/auth/pair`, or an auth error (so the client can
 * read `unauthorized` vs `remote_disabled`).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AuthService, Identity, RequestMeta } from "../services/auth/auth-service.js";

declare module "hono" {
  interface ContextVariableMap {
    /** Who made the request (set by {@link securityMiddleware}). */
    identity: Identity;
  }
}

export interface SecurityOptions {
  /** Device auth, the remote switch and the Host allow-list. */
  auth: AuthService;
  /** Ports whose loopback origins are this server's own (its port, its web dev server's). */
  ownPorts?: () => number[];
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Methods and headers a cross-origin client may use (preflight answers). */
const CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "content-type, x-glade-command-id, authorization";
/** Response headers a cross-origin client may read (exports' file names). */
const CORS_EXPOSE = "content-disposition";
/** How long browsers may cache a preflight (s). */
const CORS_MAX_AGE = "600";

/** Default web dev server port (`pnpm dev`'s Vite). */
export const DEFAULT_WEB_PORT = 5317;

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Loopback peer addresses (IPv4 127/8, IPv6 ::1, IPv4-mapped). */
export function isLoopbackAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a);
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
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** A loopback http(s) origin (scheme, host and port only) on one of `ports`. */
export function isOwnOrigin(origin: string, ports: Iterable<number>): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || origin.endsWith("/")) return false;
    if (!isLoopbackHostname(url.hostname)) return false;
    const port = portOf(url);
    for (const p of ports) if (p === port) return true;
    return false;
  } catch {
    return false;
  }
}

/** Headers a proxy in front of us adds (a request carrying any of them isn't local). */
export function hasProxyHeaders(headers: Headers): boolean {
  for (const name of headers.keys()) {
    const n = name.toLowerCase();
    if (n === "forwarded" || n.startsWith("x-forwarded-") || n.startsWith("tailscale-user-")) return true;
  }
  return false;
}

/** The TCP peer's address; null for in-process requests (tests). */
function peerAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

/** Where a remote request comes from (the proxy's `X-Forwarded-For` when there is one) and its Tailscale login hint. */
export function requestMeta(c: Context): RequestMeta {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const peer = peerAddress(c);
  return {
    address: forwarded || (peer ? peer.replace(/^::ffff:/, "") : null),
    tailscaleLogin: c.req.header("tailscale-user-login")?.trim() || null,
  };
}

/**
 * The Tailscale login Tailscale Serve vouches for (I-143), or null. Serve proxies from loopback
 * and replaces any `Tailscale-User-Login` the client sent, so the header counts only when the TCP
 * peer is loopback (in-process test requests count as loopback, as in {@link isLocalOwner}).
 * Tagged devices get no login. Anyone who can already run code on this host could forge it, but
 * they're the local owner anyway.
 */
export function servedTailscaleLogin(c: Context): string | null {
  const peer = peerAddress(c);
  if (peer !== null && !isLoopbackAddress(peer)) return null;
  const login = c.req.header("tailscale-user-login")?.trim();
  return login && !/[\s,]/.test(login) ? login : null;
}

/** Is this request the local owner? (See the header comment.) */
export function isLocalOwner(c: Context, ownPorts: number[]): boolean {
  const peer = peerAddress(c);
  if (peer !== null && !isLoopbackAddress(peer)) return false;
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  const hostname = hostHeaderHostname(host);
  if (!hostname || !isLoopbackHostname(hostname)) return false;
  if (hasProxyHeaders(c.req.raw.headers)) return false;
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  let hostPort: number | null = null;
  try {
    hostPort = portOf(new URL(`http://${host}`));
  } catch {
    /* checked above */
  }
  return isOwnOrigin(origin, hostPort === null ? ownPorts : [hostPort, ...ownPorts]);
}

function bearer(c: Context): string | null {
  const value = c.req.header("authorization");
  const m = value?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1]! : null;
}

function setCors(headers: Headers, origin: string): void {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE);
  headers.append("Vary", "Origin");
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || isSocketPath(path);
}

/** WebSocket routes (`/ws`, and `/ws/terminal/:id`, I-187): remote clients authenticate with a one-time ticket. */
function isSocketPath(path: string): boolean {
  return path === "/ws" || path.startsWith("/ws/");
}

/** Default own ports when the caller doesn't know them: the web dev server's. */
export function defaultOwnPorts(): number[] {
  const web = Number(process.env.GLADE_WEB_PORT || process.env.PI_UI_WEB_PORT || DEFAULT_WEB_PORT);
  return Number.isInteger(web) && web > 0 ? [web] : [];
}

export function securityMiddleware({ auth, ownPorts = defaultOwnPorts }: SecurityOptions): MiddlewareHandler {
  return async (c, next) => {
    // Node's server always sets Host; in-process requests (tests) fall back to the URL.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostHeaderHostname(host);
    if (!hostname || !(isLoopbackHostname(hostname) || auth.allowedHostnames().has(hostname.toLowerCase()))) {
      return c.json({ error: "Forbidden host" }, 403);
    }

    const origin = c.req.header("origin");
    // CORS preflight: no credentials, nothing to protect; the real request is checked.
    if (c.req.method === "OPTIONS" && origin !== undefined && c.req.header("access-control-request-method")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": CORS_METHODS,
          "Access-Control-Allow-Headers": CORS_HEADERS,
          "Access-Control-Max-Age": CORS_MAX_AGE,
          Vary: "Origin, Access-Control-Request-Headers",
        },
      });
    }

    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const cors = origin !== undefined && !isUpgrade ? origin : null;
    const refuse = (status: 401 | 403, code: string, error: string) => {
      const res = c.json({ code, error }, status);
      if (cors) setCors(res.headers, cors);
      return res;
    };

    if (isLocalOwner(c, ownPorts())) {
      c.set("identity", { kind: "local" });
    } else {
      if (!auth.isRemoteEnabled()) return refuse(403, "remote_disabled", "This host doesn't accept remote devices right now.");
      const meta = requestMeta(c);
      const path = c.req.path;
      const isGet = c.req.method === "GET" || c.req.method === "HEAD";
      // Without a token: pairing, the environment's identity (id, name, version, protocol: what
      // a pairing client checks the link against; the route trims the rest) and static files.
      const unauthenticated =
        ((path === "/api/auth/pair" || path === "/api/auth/pair/wait") && c.req.method === "POST") || (path === "/api/environment" && isGet) || (!isApiPath(path) && isGet);
      let device = null;
      // A token, when sent, is always checked (a bad one is 401 even where none is needed).
      if (!unauthenticated || (!isSocketPath(path) && bearer(c) !== null)) {
        device = isSocketPath(path) ? auth.redeemTicket(c.req.query("ticket") ?? null, meta) : auth.authenticate(bearer(c), meta);
        if (!device) return refuse(401, "unauthorized", "This device isn't paired with the host (or was removed). Pair it again.");
      }
      c.set("identity", { kind: "remote", device, ...meta });
    }

    if (cors) setCors(c.res.headers, cors);
    await next();
    // Responses made without the context (e.g. replayed command receipts) don't carry the
    // headers set above; add them now.
    if (cors && !c.res.headers.has("Access-Control-Allow-Origin")) {
      try {
        setCors(c.res.headers, cors);
      } catch {
        /* immutable headers (a fetched response): nothing to add */
      }
    }
  };
}

/** Middleware: only the local owner may call this route (403 `local_only` for remote clients). */
export const localOnly: MiddlewareHandler = async (c, next) => {
  if (c.get("identity")?.kind !== "local") return c.json({ code: "local_only", error: "Only the host itself can do this." }, 403);
  await next();
};

/** True when the request is the local owner. */
export function isLocal(c: Context): boolean {
  return c.get("identity")?.kind === "local";
}
